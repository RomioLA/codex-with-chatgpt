#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#include <sdkddkver.h>
#ifndef NTDDI_VERSION
#define NTDDI_VERSION NTDDI_WIN10_RS1
#endif
#if NTDDI_VERSION < NTDDI_WIN10_RS1
#undef NTDDI_VERSION
#define NTDDI_VERSION NTDDI_WIN10_RS1
#endif
#include <windows.h>
#include <aclapi.h>
#include <bcrypt.h>
#include <sddl.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cwchar>
#include <iterator>
#include <mutex>
#include <cstring>
#include <iomanip>
#include <sstream>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace {

constexpr DWORD kMaxFieldBytes = 131072;
constexpr DWORD kMaxTargetBytes = 64;
constexpr DWORD kMaxFrameBytes = 64 * 1024;
constexpr DWORD kMaxGenericArguments = 256;
constexpr DWORD kMaxGenericMaterials = 256;
constexpr DWORD kJobDrainLimitMs = 30000;
constexpr DWORD kNoChildExitCode = 0xFFFFFFFFu;

constexpr BYTE kOutcomeCompleted = 0;
constexpr BYTE kOutcomeCancelled = 1;
constexpr BYTE kOutcomeTimedOut = 2;
constexpr BYTE kOutcomeHelperError = 3;

constexpr BYTE kFrameStdout = 1;
constexpr BYTE kFrameStderr = 2;
constexpr BYTE kFrameResult = 3;

constexpr BYTE kRequestMagicV5[8] = {'C', '2', 'C', 'J', 'O', 'B', '5', 0};
constexpr BYTE kRequestMagicV7[8] = {'C', '2', 'C', 'J', 'O', 'B', '7', 0};
constexpr BYTE kRequestMagicV8[8] = {'C', '2', 'C', 'J', 'O', 'B', '8', 0};
constexpr BYTE kOutputMagic[8] = {'C', '2', 'C', 'O', 'U', 'T', '8', 0};
constexpr BYTE kTempCleanupMagic[8] = {'C', '2', 'C', 'T', 'M', 'P', '1', 0};

struct UniqueHandle {
    HANDLE value = INVALID_HANDLE_VALUE;

    UniqueHandle() = default;
    explicit UniqueHandle(HANDLE handle) : value(handle) {}
    UniqueHandle(const UniqueHandle&) = delete;
    UniqueHandle& operator=(const UniqueHandle&) = delete;

    UniqueHandle(UniqueHandle&& other) noexcept : value(other.release()) {}
    UniqueHandle& operator=(UniqueHandle&& other) noexcept {
        if (this != &other) {
            reset(other.release());
        }
        return *this;
    }

    ~UniqueHandle() { reset(); }

    bool valid() const { return value != nullptr && value != INVALID_HANDLE_VALUE; }
    HANDLE get() const { return value; }

    HANDLE release() {
        HANDLE result = value;
        value = INVALID_HANDLE_VALUE;
        return result;
    }

    void reset(HANDLE next = INVALID_HANDLE_VALUE) {
        if (valid()) {
            CloseHandle(value);
        }
        value = next;
    }
};

struct AtomicEditMutex {
    HANDLE value = nullptr;
    bool owned = false;

    AtomicEditMutex() = default;
    AtomicEditMutex(const AtomicEditMutex&) = delete;
    AtomicEditMutex& operator=(const AtomicEditMutex&) = delete;

    ~AtomicEditMutex() {
        if (owned) ReleaseMutex(value);
        if (value != nullptr) CloseHandle(value);
    }

    bool acquire(const std::wstring& name, DWORD& error) {
        value = CreateMutexW(nullptr, FALSE, name.c_str());
        if (value == nullptr) {
            error = GetLastError();
            return false;
        }
        const DWORD wait = WaitForSingleObject(value, 9000);
        if (wait == WAIT_OBJECT_0 || wait == WAIT_ABANDONED) {
            owned = true;
            return true;
        }
        error = wait == WAIT_TIMEOUT ? ERROR_TIMEOUT : GetLastError();
        return false;
    }
};

// Cross-process counterpart to permission/store.ts's exclusive .json.lock.
// The file remains present until the helper has crossed ResumeThread.
struct PermissionLaunchPermit {
    HANDLE value = INVALID_HANDLE_VALUE;
    std::wstring path;
    DWORD volumeSerial = 0;
    DWORD fileIndexHigh = 0;
    DWORD fileIndexLow = 0;

    PermissionLaunchPermit() = default;
    PermissionLaunchPermit(const PermissionLaunchPermit&) = delete;
    PermissionLaunchPermit& operator=(const PermissionLaunchPermit&) = delete;
    ~PermissionLaunchPermit() { reset(); }

    bool acquire(const std::wstring& lockPath, DWORD& error) {
        static std::atomic<std::uint64_t> stagingSequence{0};
        const std::wstring stagingPath = lockPath + L".launch-" +
            std::to_wstring(GetCurrentProcessId()) + L"-" +
            std::to_wstring(GetTickCount64()) + L"-" +
            std::to_wstring(stagingSequence.fetch_add(1, std::memory_order_relaxed));
        value = CreateFileW(stagingPath.c_str(), GENERIC_READ | GENERIC_WRITE | DELETE,
                            FILE_SHARE_READ | FILE_SHARE_DELETE, nullptr, CREATE_NEW,
                            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
        if (value == INVALID_HANDLE_VALUE) {
            error = GetLastError();
            return false;
        }
        FILE_ATTRIBUTE_TAG_INFO attributes{};
        BY_HANDLE_FILE_INFORMATION identity{};
        if (!GetFileInformationByHandleEx(value, FileAttributeTagInfo, &attributes, sizeof(attributes)) ||
            !GetFileInformationByHandle(value, &identity) ||
            (attributes.FileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)) != 0) {
            error = GetLastError();
            if (error == ERROR_SUCCESS) error = ERROR_INVALID_DATA;
            CloseHandle(value);
            value = INVALID_HANDLE_VALUE;
            DeleteFileW(stagingPath.c_str());
            return false;
        }
        volumeSerial = identity.dwVolumeSerialNumber;
        fileIndexHigh = identity.nFileIndexHigh;
        fileIndexLow = identity.nFileIndexLow;
        const std::string owner = "launch:" + std::to_string(GetCurrentProcessId()) + "\n";
        DWORD written = 0;
        if (!WriteFile(value, owner.data(), static_cast<DWORD>(owner.size()), &written, nullptr) ||
            written != owner.size() || !FlushFileBuffers(value)) {
            error = GetLastError();
            if (error == ERROR_SUCCESS) error = ERROR_WRITE_FAULT;
            CloseHandle(value);
            value = INVALID_HANDLE_VALUE;
            DeleteFileW(stagingPath.c_str());
            return false;
        }
        // Publish only after the launch marker is complete. Readers can then
        // distinguish this immutable Resume permit from a permission mutation
        // without observing an empty or partially written common lock file.
        if (!MoveFileExW(stagingPath.c_str(), lockPath.c_str(), MOVEFILE_WRITE_THROUGH)) {
            error = GetLastError();
            CloseHandle(value);
            value = INVALID_HANDLE_VALUE;
            DeleteFileW(stagingPath.c_str());
            return false;
        }
        path = lockPath;
        return true;
    }

    void reset() {
        if (value == INVALID_HANDLE_VALUE) return;
        const std::wstring lockPath = path;
        const DWORD expectedVolume = volumeSerial;
        const DWORD expectedIndexHigh = fileIndexHigh;
        const DWORD expectedIndexLow = fileIndexLow;
        FILE_DISPOSITION_INFO disposition{};
        disposition.DeleteFile = TRUE;
        const bool deleteByHandle = SetFileInformationByHandle(
            value, FileDispositionInfo, &disposition, sizeof(disposition)) != FALSE;
        CloseHandle(value);
        value = INVALID_HANDLE_VALUE;
        path.clear();
        if (deleteByHandle) return;

        HANDLE current = CreateFileW(lockPath.c_str(), FILE_READ_ATTRIBUTES,
                                     FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                                     nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
        if (current == INVALID_HANDLE_VALUE) return;
        FILE_ATTRIBUTE_TAG_INFO attributes{};
        BY_HANDLE_FILE_INFORMATION identity{};
        const bool matches = GetFileInformationByHandleEx(current, FileAttributeTagInfo,
                &attributes, sizeof(attributes)) &&
            GetFileInformationByHandle(current, &identity) &&
            (attributes.FileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)) == 0 &&
            identity.dwVolumeSerialNumber == expectedVolume &&
            identity.nFileIndexHigh == expectedIndexHigh &&
            identity.nFileIndexLow == expectedIndexLow;
        CloseHandle(current);
        if (matches) DeleteFileW(lockPath.c_str());
    }
};

struct UniqueModule {
    HMODULE value = nullptr;

    UniqueModule() = default;
    explicit UniqueModule(HMODULE module) : value(module) {}
    UniqueModule(const UniqueModule&) = delete;
    UniqueModule& operator=(const UniqueModule&) = delete;
    ~UniqueModule() { if (value != nullptr) FreeLibrary(value); }
};

struct Request {
    std::uint16_t protocolVersion = 7;
    BYTE recipe = 1;
    BYTE manager = 0;
    BYTE kind = 0;
    DWORD timeoutSeconds = 0;
    std::wstring cwd;
    std::wstring gitDirectory;
    std::wstring gitDirectoryFileIdentity;
    std::wstring commonGitDirectory;
    std::wstring commonGitDirectoryFileIdentity;
    std::wstring nodeExecutable;
    std::wstring nodeFileIdentity;
    std::wstring nodeHash;
    std::wstring managerCli;
    std::wstring managerFileIdentity;
    std::wstring managerHash;
    std::wstring managerLibCli;
    std::wstring managerLibCliFileIdentity;
    std::wstring managerLibCliHash;
    std::wstring managerValidateEngines;
    std::wstring managerValidateEnginesFileIdentity;
    std::wstring managerValidateEnginesHash;
    std::wstring managerMainEntry;
    std::wstring managerMainEntryFileIdentity;
    std::wstring managerMainEntryHash;
    std::wstring managerPackageJson;
    std::wstring managerPackageJsonFileIdentity;
    std::wstring managerPackageJsonHash;
    std::wstring managerExitHandler;
    std::wstring managerExitHandlerFileIdentity;
    std::wstring managerExitHandlerHash;
    std::wstring managerCore;
    std::wstring managerCoreFileIdentity;
    std::wstring managerCoreHash;
    std::wstring target;
    std::wstring tempRootPath;
    std::wstring tempRootFileIdentity;
    std::wstring tempWorkspaceId;
    std::wstring tempJobId;
    std::wstring tempNonce;
    std::wstring tempCreatedAtMs;
    std::wstring jobTempDir;
    std::wstring jobTempFileIdentity;
    std::wstring repositoryFileIdentity;
    std::wstring gitEntryFileIdentity;
    BYTE gitEntryType = 0;
    std::wstring gitEntryHash;
    std::wstring packageJsonHash;
    BYTE genericMode = 0;
    std::wstring genericExecutable;
    std::wstring genericExecutableFileIdentity;
    std::wstring genericExecutableHash;
    std::vector<std::wstring> genericArguments;
    std::wstring genericCommandText;
    std::wstring genericCwd;
    std::wstring genericCwdFileIdentity;
    std::wstring fullAccessWorkspaceId;
    std::wstring fullAccessJobId;
    std::wstring oauthClientId;
    std::wstring permissionMode;
    std::wstring sessionGrantFingerprint;
    std::wstring sessionGrantId;
    std::wstring idempotencyKeyHash;
    std::wstring requestHash;
    bool hasFullAccessGrant = false;
    std::wstring approvalManifest;
    std::wstring approvalManifestFileIdentity;
    std::wstring approvalManifestHash;
    struct Material {
        std::wstring path;
        std::wstring fileIdentity;
        std::wstring hash;
    };
    std::vector<Material> genericMaterials;
    std::vector<Material> launchSnapshots;
};

struct TempCleanupRequest {
    std::wstring rootPath;
    std::wstring rootFileIdentity;
    std::wstring directoryFileIdentity;
    std::wstring workspaceId;
    std::wstring jobId;
    std::wstring nonce;
    std::wstring createdAtMs;
};

enum class ControlEvent : int {
    None = 0,
    Cancel = 1,
    OwnerLost = 2,
    ProtocolError = 3,
};

enum class Outcome : BYTE {
    Completed = kOutcomeCompleted,
    Cancelled = kOutcomeCancelled,
    TimedOut = kOutcomeTimedOut,
    HelperError = kOutcomeHelperError,
    AuthorizationDenied = 4,
    PrelaunchStateChanged = 5,
};

std::mutex g_outputMutex;
std::atomic<DWORD> g_outputError{0};

bool WriteAll(HANDLE handle, const void* data, DWORD length, DWORD& error) {
    const BYTE* current = static_cast<const BYTE*>(data);
    DWORD remaining = length;
    while (remaining != 0) {
        DWORD written = 0;
        if (!WriteFile(handle, current, remaining, &written, nullptr)) {
            error = GetLastError();
            return false;
        }
        if (written == 0) {
            error = ERROR_WRITE_FAULT;
            return false;
        }
        current += written;
        remaining -= written;
    }
    return true;
}

bool WriteHeader(HANDLE output, DWORD& error) {
    return WriteAll(output, kOutputMagic, static_cast<DWORD>(sizeof(kOutputMagic)), error);
}

bool WriteFrame(HANDLE output, BYTE type, const BYTE* payload, DWORD length, DWORD& error) {
    if (length > kMaxFrameBytes) {
        error = ERROR_INVALID_DATA;
        return false;
    }

    BYTE frameHeader[5] = {
        type,
        static_cast<BYTE>(length & 0xFF),
        static_cast<BYTE>((length >> 8) & 0xFF),
        static_cast<BYTE>((length >> 16) & 0xFF),
        static_cast<BYTE>((length >> 24) & 0xFF),
    };

    std::lock_guard<std::mutex> lock(g_outputMutex);
    if (!WriteAll(output, frameHeader, static_cast<DWORD>(sizeof(frameHeader)), error)) {
        return false;
    }
    return length == 0 || WriteAll(output, payload, length, error);
}

bool EmitResult(HANDLE output, Outcome outcome, DWORD childExitCode, DWORD win32Error) {
    BYTE payload[9] = {
        static_cast<BYTE>(outcome),
        static_cast<BYTE>(childExitCode & 0xFF),
        static_cast<BYTE>((childExitCode >> 8) & 0xFF),
        static_cast<BYTE>((childExitCode >> 16) & 0xFF),
        static_cast<BYTE>((childExitCode >> 24) & 0xFF),
        static_cast<BYTE>(win32Error & 0xFF),
        static_cast<BYTE>((win32Error >> 8) & 0xFF),
        static_cast<BYTE>((win32Error >> 16) & 0xFF),
        static_cast<BYTE>((win32Error >> 24) & 0xFF),
    };
    DWORD error = ERROR_SUCCESS;
    return WriteFrame(output, kFrameResult, payload, static_cast<DWORD>(sizeof(payload)), error);
}

bool ReadExact(HANDLE input, void* destination, DWORD length, DWORD& error) {
    BYTE* current = static_cast<BYTE*>(destination);
    DWORD remaining = length;
    while (remaining != 0) {
        DWORD received = 0;
        if (!ReadFile(input, current, remaining, &received, nullptr)) {
            error = GetLastError();
            return false;
        }
        if (received == 0) {
            error = ERROR_HANDLE_EOF;
            return false;
        }
        current += received;
        remaining -= received;
    }
    return true;
}

bool ReadByte(HANDLE input, BYTE& value, DWORD& error) {
    return ReadExact(input, &value, 1, error);
}

bool ReadU16(HANDLE input, std::uint16_t& value, DWORD& error) {
    BYTE bytes[2]{};
    if (!ReadExact(input, bytes, 2, error)) {
        return false;
    }
    value = static_cast<std::uint16_t>(bytes[0]) |
            static_cast<std::uint16_t>(static_cast<std::uint16_t>(bytes[1]) << 8);
    return true;
}

bool ReadU32(HANDLE input, DWORD& value, DWORD& error) {
    BYTE bytes[4]{};
    if (!ReadExact(input, bytes, 4, error)) {
        return false;
    }
    value = static_cast<DWORD>(bytes[0]) |
            (static_cast<DWORD>(bytes[1]) << 8) |
            (static_cast<DWORD>(bytes[2]) << 16) |
            (static_cast<DWORD>(bytes[3]) << 24);
    return true;
}

bool Utf8ToWide(const std::string& input, std::wstring& output, bool allowEmpty = false) {
    if ((!allowEmpty && input.empty()) || input.find('\0') != std::string::npos ||
        input.size() > static_cast<size_t>(kMaxFieldBytes)) {
        return false;
    }
    if (input.empty()) {
        output.clear();
        return true;
    }
    const int inputLength = static_cast<int>(input.size());
    const int required = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
                                               input.data(), inputLength, nullptr, 0);
    if (required <= 0 || required > 32760) {
        return false;
    }
    std::wstring converted(static_cast<size_t>(required), L'\0');
    const int written = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
                                             input.data(), inputLength,
                                             converted.data(), required);
    if (written != required || converted.find(L'\0') != std::wstring::npos) {
        return false;
    }
    output = std::move(converted);
    return true;
}

bool ReadString(HANDLE input, DWORD maximumBytes, std::wstring& output, DWORD& error,
                bool allowEmpty = false) {
    DWORD length = 0;
    if (!ReadU32(input, length, error)) {
        return false;
    }
    if ((!allowEmpty && length == 0) || length > maximumBytes || length > kMaxFieldBytes) {
        error = ERROR_INVALID_DATA;
        return false;
    }

    std::string bytes(static_cast<size_t>(length), '\0');
    if (!ReadExact(input, bytes.data(), length, error)) {
        return false;
    }
    if (!Utf8ToWide(bytes, output, allowEmpty)) {
        error = ERROR_NO_UNICODE_TRANSLATION;
        return false;
    }
    return true;
}

bool IsHex(const std::wstring& value, size_t expectedLength);
bool IsIdentity(const std::wstring& value);
bool SameOrdinal(const std::wstring& left, const std::wstring& right);

bool ReadRequest(HANDLE input, Request& request, DWORD& error) {
    BYTE magic[8]{};
    if (!ReadExact(input, magic, static_cast<DWORD>(sizeof(magic)), error)) {
        return false;
    }
    const bool requestV5 = std::equal(std::begin(magic), std::end(magic), std::begin(kRequestMagicV5));
    const bool requestV7 = std::equal(std::begin(magic), std::end(magic), std::begin(kRequestMagicV7));
    const bool requestV8 = std::equal(std::begin(magic), std::end(magic), std::begin(kRequestMagicV8));
    if (!requestV5 && !requestV7 && !requestV8) {
        error = ERROR_INVALID_DATA;
        return false;
    }

    std::uint16_t version = 0;
    BYTE recipe = 0;
    BYTE reservedByte = 0;
    std::uint16_t reservedWord = 0;
    if (!ReadU16(input, version, error) ||
        !ReadByte(input, recipe, error) ||
        !ReadByte(input, request.manager, error) ||
        !ReadByte(input, request.kind, error) ||
        !ReadByte(input, reservedByte, error) ||
        !ReadU16(input, reservedWord, error) ||
        !ReadU32(input, request.timeoutSeconds, error)) {
        return false;
    }

    const bool validRepositoryRequest =
        (requestV5 && version == 5 && (recipe == 1 || recipe == 2) &&
         (request.manager == 1 || request.manager == 2) && request.kind >= 1 && request.kind <= 5) ||
        (requestV8 && version == 8 && recipe == 2 &&
         (request.manager == 1 || request.manager == 2) && request.kind == 5);
    const bool validHostRequest = requestV7 && version == 7 && recipe == 3 &&
        request.manager == 0 && request.kind == 0;
    if ((!validRepositoryRequest && !validHostRequest) || reservedByte != 0 || reservedWord != 0 ||
        request.timeoutSeconds < 1 || request.timeoutSeconds > 3600) {
        error = ERROR_INVALID_DATA;
        return false;
    }
    request.protocolVersion = version;
    request.recipe = recipe;

    if (request.recipe == 3) {
        DWORD argumentCount = 0;
        if (!ReadString(input, kMaxFieldBytes, request.fullAccessWorkspaceId, error) ||
            !ReadString(input, kMaxFieldBytes, request.fullAccessJobId, error) ||
            !ReadString(input, kMaxFieldBytes, request.oauthClientId, error) ||
            !ReadString(input, kMaxFieldBytes, request.permissionMode, error) ||
            !ReadString(input, kMaxFieldBytes, request.sessionGrantFingerprint, error) ||
            !ReadString(input, kMaxFieldBytes, request.sessionGrantId, error) ||
            !ReadString(input, kMaxFieldBytes, request.idempotencyKeyHash, error) ||
            !ReadString(input, kMaxFieldBytes, request.requestHash, error) ||
            !ReadByte(input, request.genericMode, error) ||
            !ReadString(input, kMaxFieldBytes, request.genericExecutable, error) ||
            !ReadString(input, kMaxFieldBytes, request.genericExecutableFileIdentity, error) ||
            !ReadString(input, kMaxFieldBytes, request.genericExecutableHash, error) ||
            !ReadU32(input, argumentCount, error) || argumentCount > kMaxGenericArguments) {
            if (error == ERROR_SUCCESS) error = ERROR_INVALID_DATA;
            return false;
        }
        request.genericArguments.reserve(argumentCount);
        for (DWORD index = 0; index < argumentCount; ++index) {
            std::wstring argument;
            if (!ReadString(input, kMaxFieldBytes, argument, error, true)) return false;
            request.genericArguments.push_back(std::move(argument));
        }
        if (!ReadString(input, kMaxFieldBytes, request.genericCommandText, error, true) ||
            !ReadString(input, kMaxFieldBytes, request.genericCwd, error) ||
            !ReadString(input, kMaxFieldBytes, request.genericCwdFileIdentity, error) ||
            !ReadString(input, kMaxFieldBytes, request.tempRootPath, error) ||
            !ReadString(input, kMaxFieldBytes, request.tempRootFileIdentity, error) ||
            !ReadString(input, kMaxFieldBytes, request.tempNonce, error) ||
            !ReadString(input, kMaxFieldBytes, request.tempCreatedAtMs, error) ||
            !ReadString(input, kMaxFieldBytes, request.jobTempDir, error) ||
            !ReadString(input, kMaxFieldBytes, request.jobTempFileIdentity, error)) {
            return false;
        }
        request.tempWorkspaceId = request.fullAccessWorkspaceId;
        request.tempJobId = request.fullAccessJobId;
        request.hasFullAccessGrant = true;
        if (request.genericMode < 1 || request.genericMode > 3 ||
            (request.genericMode == 1 && !request.genericCommandText.empty()) ||
            (request.genericMode != 1 &&
             (!request.genericArguments.empty() || request.genericCommandText.empty()))) {
            error = ERROR_INVALID_DATA;
            return false;
        }
        return true;
    }

    if (!ReadString(input, kMaxFieldBytes, request.cwd, error) ||
        !ReadString(input, kMaxFieldBytes, request.gitDirectory, error) ||
        !ReadString(input, kMaxFieldBytes, request.gitDirectoryFileIdentity, error) ||
        !ReadString(input, kMaxFieldBytes, request.commonGitDirectory, error) ||
        !ReadString(input, kMaxFieldBytes, request.commonGitDirectoryFileIdentity, error) ||
        !ReadString(input, kMaxFieldBytes, request.nodeExecutable, error) ||
        !ReadString(input, kMaxFieldBytes, request.nodeFileIdentity, error) ||
        !ReadString(input, kMaxFieldBytes, request.nodeHash, error) ||
        !ReadString(input, kMaxFieldBytes, request.managerCli, error) ||
        !ReadString(input, kMaxFieldBytes, request.managerFileIdentity, error) ||
        !ReadString(input, kMaxFieldBytes, request.managerHash, error) ||
        !ReadString(input, kMaxFieldBytes, request.managerLibCli, error) ||
        !ReadString(input, kMaxFieldBytes, request.managerLibCliFileIdentity, error) ||
        !ReadString(input, kMaxFieldBytes, request.managerLibCliHash, error) ||
        !ReadString(input, kMaxFieldBytes, request.managerValidateEngines, error) ||
        !ReadString(input, kMaxFieldBytes, request.managerValidateEnginesFileIdentity, error) ||
        !ReadString(input, kMaxFieldBytes, request.managerValidateEnginesHash, error) ||
        !ReadString(input, kMaxFieldBytes, request.managerMainEntry, error) ||
        !ReadString(input, kMaxFieldBytes, request.managerMainEntryFileIdentity, error) ||
        !ReadString(input, kMaxFieldBytes, request.managerMainEntryHash, error) ||
        !ReadString(input, kMaxFieldBytes, request.managerPackageJson, error) ||
        !ReadString(input, kMaxFieldBytes, request.managerPackageJsonFileIdentity, error) ||
        !ReadString(input, kMaxFieldBytes, request.managerPackageJsonHash, error) ||
        !ReadString(input, kMaxFieldBytes, request.managerExitHandler, error) ||
        !ReadString(input, kMaxFieldBytes, request.managerExitHandlerFileIdentity, error) ||
        !ReadString(input, kMaxFieldBytes, request.managerExitHandlerHash, error) ||
        !ReadString(input, kMaxFieldBytes, request.managerCore, error) ||
        !ReadString(input, kMaxFieldBytes, request.managerCoreFileIdentity, error) ||
        !ReadString(input, kMaxFieldBytes, request.managerCoreHash, error) ||
        !ReadString(input, kMaxTargetBytes, request.target, error) ||
        !ReadString(input, kMaxFieldBytes, request.tempRootPath, error) ||
        !ReadString(input, kMaxFieldBytes, request.tempRootFileIdentity, error) ||
        !ReadString(input, kMaxFieldBytes, request.tempWorkspaceId, error) ||
        !ReadString(input, kMaxFieldBytes, request.tempJobId, error) ||
        !ReadString(input, kMaxFieldBytes, request.tempNonce, error) ||
        !ReadString(input, kMaxFieldBytes, request.tempCreatedAtMs, error) ||
        !ReadString(input, kMaxFieldBytes, request.jobTempDir, error) ||
        !ReadString(input, kMaxFieldBytes, request.jobTempFileIdentity, error) ||
        !ReadString(input, kMaxFieldBytes, request.repositoryFileIdentity, error) ||
        !ReadString(input, kMaxFieldBytes, request.gitEntryFileIdentity, error) ||
        !ReadByte(input, request.gitEntryType, error) ||
        !ReadString(input, kMaxFieldBytes, request.gitEntryHash, error) ||
        !ReadString(input, kMaxFieldBytes, request.packageJsonHash, error)) {
        return false;
    }
    if ((request.gitEntryType != 1 && request.gitEntryType != 2) ||
        !IsHex(request.nodeHash, 64) || !IsHex(request.managerHash, 64) ||
        !IsHex(request.managerLibCliHash, 64) || !IsHex(request.managerValidateEnginesHash, 64) ||
        !IsHex(request.managerMainEntryHash, 64) || !IsHex(request.managerPackageJsonHash, 64) ||
        !IsHex(request.managerExitHandlerHash, 64) || !IsHex(request.managerCoreHash, 64) ||
        !IsHex(request.gitEntryHash, 64) ||
        !IsHex(request.packageJsonHash, 64) ||
        !IsIdentity(request.nodeFileIdentity) || !IsIdentity(request.managerFileIdentity) ||
        !IsIdentity(request.managerLibCliFileIdentity) ||
        !IsIdentity(request.managerValidateEnginesFileIdentity) ||
        !IsIdentity(request.managerMainEntryFileIdentity) ||
        !IsIdentity(request.managerPackageJsonFileIdentity) ||
        !IsIdentity(request.managerExitHandlerFileIdentity) ||
        !IsIdentity(request.managerCoreFileIdentity)) {
        error = ERROR_INVALID_DATA;
        return false;
    }
    if (request.recipe == 2) {
        DWORD argumentCount = 0;
        DWORD materialCount = 0;
        if (!ReadByte(input, request.genericMode, error) ||
            !ReadString(input, kMaxFieldBytes, request.genericExecutable, error) ||
            !ReadString(input, kMaxFieldBytes, request.genericExecutableFileIdentity, error) ||
            !ReadString(input, kMaxFieldBytes, request.genericExecutableHash, error) ||
            !ReadU32(input, argumentCount, error) || argumentCount > kMaxGenericArguments) {
            if (error == ERROR_SUCCESS) error = ERROR_INVALID_DATA;
            return false;
        }
        request.genericArguments.reserve(argumentCount);
        for (DWORD index = 0; index < argumentCount; ++index) {
            std::wstring argument;
            if (!ReadString(input, kMaxFieldBytes, argument, error, true)) return false;
            request.genericArguments.push_back(std::move(argument));
        }
        if (!ReadString(input, kMaxFieldBytes, request.genericCommandText, error, true) ||
            !ReadString(input, kMaxFieldBytes, request.genericCwd, error) ||
            !ReadString(input, kMaxFieldBytes, request.genericCwdFileIdentity, error) ||
            !ReadString(input, kMaxFieldBytes, request.approvalManifest, error) ||
            !ReadString(input, kMaxFieldBytes, request.approvalManifestFileIdentity, error) ||
            !ReadString(input, kMaxFieldBytes, request.approvalManifestHash, error) ||
            !ReadU32(input, materialCount, error) || materialCount > kMaxGenericMaterials) {
            if (error == ERROR_SUCCESS) error = ERROR_INVALID_DATA;
            return false;
        }
        request.genericMaterials.reserve(materialCount);
        for (DWORD index = 0; index < materialCount; ++index) {
            Request::Material material;
            if (!ReadString(input, kMaxFieldBytes, material.path, error) ||
                !ReadString(input, kMaxFieldBytes, material.fileIdentity, error) ||
                !ReadString(input, kMaxFieldBytes, material.hash, error)) return false;
            request.genericMaterials.push_back(std::move(material));
        }
        DWORD snapshotCount = 0;
        if (!ReadU32(input, snapshotCount, error) || snapshotCount > kMaxGenericMaterials) return false;
        for (DWORD index = 0; index < snapshotCount; ++index) {
            Request::Material material;
            if (!ReadString(input, kMaxFieldBytes, material.path, error) ||
                !ReadString(input, kMaxFieldBytes, material.fileIdentity, error) ||
                !ReadString(input, kMaxFieldBytes, material.hash, error) ||
                !IsIdentity(material.fileIdentity) || !IsHex(material.hash, 64)) return false;
            request.launchSnapshots.push_back(std::move(material));
        }
        if (requestV8) {
            if (!ReadString(input, kMaxFieldBytes, request.fullAccessWorkspaceId, error) ||
                !ReadString(input, kMaxFieldBytes, request.fullAccessJobId, error) ||
                !ReadString(input, kMaxFieldBytes, request.oauthClientId, error) ||
                !ReadString(input, kMaxFieldBytes, request.permissionMode, error) ||
                !ReadString(input, kMaxFieldBytes, request.sessionGrantFingerprint, error) ||
                !ReadString(input, kMaxFieldBytes, request.sessionGrantId, error)) return false;
            if (request.fullAccessWorkspaceId != request.tempWorkspaceId ||
                request.fullAccessJobId != request.tempJobId ||
                request.oauthClientId.empty() || request.oauthClientId.size() > 200 ||
                request.permissionMode != L"level2" ||
                !IsHex(request.sessionGrantFingerprint, 64) || !IsHex(request.sessionGrantId, 64)) {
                error = ERROR_INVALID_DATA;
                return false;
            }
            request.hasFullAccessGrant = true;
        }
        const bool validMode = request.genericMode >= 1 && request.genericMode <= 3;
        const bool validCommandShape = request.genericMode == 1
            ? request.genericCommandText.empty()
            : !request.genericCommandText.empty() && request.genericArguments.empty();
        if (!validMode || !validCommandShape ||
            !IsIdentity(request.genericExecutableFileIdentity) ||
            !IsHex(request.genericExecutableHash, 64) ||
            !IsIdentity(request.genericCwdFileIdentity) ||
            !IsIdentity(request.approvalManifestFileIdentity) ||
            !IsHex(request.approvalManifestHash, 64) ||
            !SameOrdinal(request.packageJsonHash, request.approvalManifestHash)) {
            error = ERROR_INVALID_DATA;
            return false;
        }
        for (const auto& material : request.genericMaterials) {
            if (!IsIdentity(material.fileIdentity) || !IsHex(material.hash, 64)) {
                error = ERROR_INVALID_DATA;
                return false;
            }
        }
    }
    return true;
}

bool ReadTempCleanupRequest(HANDLE input, TempCleanupRequest& request, DWORD& error) {
    BYTE magic[8]{};
    std::uint16_t version = 0;
    BYTE reservedByte = 0;
    std::uint16_t reservedWord = 0;
    if (!ReadExact(input, magic, static_cast<DWORD>(sizeof(magic)), error) ||
        !std::equal(std::begin(magic), std::end(magic), std::begin(kTempCleanupMagic)) ||
        !ReadU16(input, version, error) || !ReadByte(input, reservedByte, error) ||
        !ReadU16(input, reservedWord, error)) {
        if (error == ERROR_SUCCESS) error = ERROR_INVALID_DATA;
        return false;
    }
    if (version != 1 || reservedByte != 0 || reservedWord != 0 ||
        !ReadString(input, kMaxFieldBytes, request.rootPath, error) ||
        !ReadString(input, kMaxFieldBytes, request.rootFileIdentity, error) ||
        !ReadString(input, kMaxFieldBytes, request.directoryFileIdentity, error) ||
        !ReadString(input, kMaxFieldBytes, request.workspaceId, error) ||
        !ReadString(input, kMaxFieldBytes, request.jobId, error) ||
        !ReadString(input, kMaxFieldBytes, request.nonce, error) ||
        !ReadString(input, kMaxFieldBytes, request.createdAtMs, error)) {
        if (error == ERROR_SUCCESS) error = ERROR_INVALID_DATA;
        return false;
    }
    return true;
}

bool IsAsciiAlphaNumeric(wchar_t value) {
    return (value >= L'a' && value <= L'z') ||
           (value >= L'A' && value <= L'Z') ||
           (value >= L'0' && value <= L'9');
}

bool ValidateTarget(const Request& request) {
    static const wchar_t* const fixedTargets[] = {
        L"test", L"build", L"lint", L"typecheck",
    };
    if (request.kind >= 1 && request.kind <= 4) {
        return request.target == fixedTargets[request.kind - 1];
    }
    if (request.kind != 5 || request.target.empty() || request.target.size() > 64 ||
        !IsAsciiAlphaNumeric(request.target[0])) {
        return false;
    }
    for (wchar_t ch : request.target) {
        if (!IsAsciiAlphaNumeric(ch) && ch != L'.' && ch != L'_' && ch != L'-') {
            return false;
        }
    }
    return true;
}

std::wstring PathBasename(const std::wstring& path) {
    const size_t separator = path.find_last_of(L'\\');
    return separator == std::wstring::npos ? path : path.substr(separator + 1);
}

std::wstring ParentDirectory(const std::wstring& path) {
    const size_t separator = path.find_last_of(L'\\');
    return separator == 2 ? path.substr(0, 3) : path.substr(0, separator);
}

bool IsAsciiDriveAbsolutePath(const std::wstring& path) {
    return path.size() >= 3 &&
           ((path[0] >= L'A' && path[0] <= L'Z') || (path[0] >= L'a' && path[0] <= L'z')) &&
           path[1] == L':' && path[2] == L'\\';
}

bool CheckPathObject(const std::wstring& path, bool expectDirectory, DWORD& error) {
    UniqueHandle handle(CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES,
                                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                                    nullptr, OPEN_EXISTING,
                                    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                                    nullptr));
    if (!handle.valid()) {
        error = GetLastError();
        return false;
    }

    FILE_ATTRIBUTE_TAG_INFO info{};
    if (!GetFileInformationByHandleEx(handle.get(), FileAttributeTagInfo,
                                      &info, sizeof(info))) {
        error = GetLastError();
        return false;
    }
    if ((info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
        error = ERROR_REPARSE_TAG_INVALID;
        return false;
    }
    const bool isDirectory = (info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
    if (isDirectory != expectDirectory) {
        error = ERROR_DIRECTORY;
        return false;
    }
    return true;
}

bool ValidateCanonicalPath(const std::wstring& input, bool expectDirectory,
                           std::wstring& canonical, DWORD& error) {
    if (input.empty() || input.size() > 32760 || !IsAsciiDriveAbsolutePath(input) ||
        input.find(L'/') != std::wstring::npos ||
        (input.size() > 3 && input.back() == L'\\')) {
        error = ERROR_INVALID_NAME;
        return false;
    }

    const DWORD needed = GetFullPathNameW(input.c_str(), 0, nullptr, nullptr);
    if (needed == 0 || needed > 32760) {
        error = needed == 0 ? GetLastError() : ERROR_FILENAME_EXCED_RANGE;
        return false;
    }
    std::vector<wchar_t> fullBuffer(static_cast<size_t>(needed) + 1, L'\0');
    const DWORD fullLength = GetFullPathNameW(input.c_str(),
                                              static_cast<DWORD>(fullBuffer.size()),
                                              fullBuffer.data(), nullptr);
    if (fullLength == 0 || fullLength >= fullBuffer.size()) {
        error = fullLength == 0 ? GetLastError() : ERROR_FILENAME_EXCED_RANGE;
        return false;
    }
    const std::wstring fullPath(fullBuffer.data(), fullLength);
    if (CompareStringOrdinal(input.c_str(), -1, fullPath.c_str(), -1, TRUE) != CSTR_EQUAL) {
        error = ERROR_INVALID_NAME;
        return false;
    }
    if (input.size() == 3 && !expectDirectory) {
        error = ERROR_DIRECTORY;
        return false;
    }

    // Check every existing path component with OPEN_REPARSE_POINT. No junction,
    // symlink, mount point, or other reparse component may participate in a path.
    std::wstring componentPath = input.substr(0, 3);
    if (!CheckPathObject(componentPath, true, error)) {
        return false;
    }

    size_t cursor = 3;
    while (cursor < input.size()) {
        const size_t separator = input.find(L'\\', cursor);
        const size_t end = separator == std::wstring::npos ? input.size() : separator;
        const std::wstring component = input.substr(cursor, end - cursor);
        if (component.empty() || component == L"." || component == L".." ||
            component.back() == L'.' || component.back() == L' ' ||
            component.find_first_of(L"<>:\"|?*") != std::wstring::npos) {
            error = ERROR_INVALID_NAME;
            return false;
        }
        componentPath += component;
        const bool finalComponent = end == input.size();
        if (!CheckPathObject(componentPath, finalComponent ? expectDirectory : true, error)) {
            return false;
        }
        if (!finalComponent) {
            componentPath.push_back(L'\\');
        }
        cursor = end + 1;
    }

    canonical = input;
    return true;
}

bool IsBasename(const std::wstring& path, const wchar_t* expected) {
    const std::wstring base = PathBasename(path);
    return CompareStringOrdinal(base.c_str(), -1, expected, -1, TRUE) == CSTR_EQUAL;
}

bool HasExeExtension(const std::wstring& path) {
    const std::wstring base = PathBasename(path);
    const size_t dot = base.find_last_of(L'.');
    return dot != std::wstring::npos &&
        CompareStringOrdinal(base.c_str() + dot, -1, L".exe", -1, TRUE) == CSTR_EQUAL;
}

bool HasFullAccessExecutableExtension(const std::wstring& path) {
    const std::wstring base = PathBasename(path);
    const size_t dot = base.find_last_of(L'.');
    if (dot == std::wstring::npos) return false;
    const wchar_t* extension = base.c_str() + dot;
    return CompareStringOrdinal(extension, -1, L".exe", -1, TRUE) == CSTR_EQUAL ||
           CompareStringOrdinal(extension, -1, L".com", -1, TRUE) == CSTR_EQUAL;
}

bool IsPathWithinDirectory(const std::wstring& root, const std::wstring& candidate) {
    if (candidate.size() < root.size() ||
        CompareStringOrdinal(root.c_str(), static_cast<int>(root.size()),
                             candidate.c_str(), static_cast<int>(root.size()), TRUE) != CSTR_EQUAL) {
        return false;
    }
    return candidate.size() == root.size() || root.back() == L'\\' || candidate[root.size()] == L'\\';
}

bool IsSafeLabel(const std::wstring& value, size_t maximumLength);
bool ReadEnvironmentValue(const wchar_t* name, std::wstring& value, DWORD& error);

bool ExpectedExecutionTempRoot(const std::wstring& workspaceId,
                               std::wstring& expectedRoot, DWORD& error) {
    if (!IsSafeLabel(workspaceId, 128)) {
        error = ERROR_INVALID_DATA;
        return false;
    }
    std::wstring stateRoot;
    if (!ReadEnvironmentValue(L"C2C_STATE_DIR", stateRoot, error)) {
        if (error != ERROR_SUCCESS) return false;
        std::wstring localAppData;
        if (!ReadEnvironmentValue(L"LOCALAPPDATA", localAppData, error)) {
            if (error != ERROR_SUCCESS) return false;
            std::wstring profile;
            if (!ReadEnvironmentValue(L"USERPROFILE", profile, error) || error != ERROR_SUCCESS) {
                if (error == ERROR_SUCCESS) error = ERROR_PATH_NOT_FOUND;
                return false;
            }
            localAppData = profile + L"\\AppData\\Local";
        }
        stateRoot = localAppData + L"\\OpenAI\\c2c-local";
    }

    std::wstring canonicalStateRoot;
    if (!ValidateCanonicalPath(stateRoot, true, canonicalStateRoot, error)) return false;
    const std::wstring candidate = canonicalStateRoot + L"\\execution-jobs\\" +
                                   workspaceId + L"\\execution-temp";
    return ValidateCanonicalPath(candidate, true, expectedRoot, error);
}

bool IsHex(const std::wstring& value, size_t expectedLength) {
    return value.size() == expectedLength && std::all_of(value.begin(), value.end(), [](wchar_t ch) {
        return (ch >= L'0' && ch <= L'9') || (ch >= L'a' && ch <= L'f') ||
               (ch >= L'A' && ch <= L'F');
    });
}

bool IsWorkspaceId(const std::wstring& value) {
    return value.size() == 12 && std::all_of(value.begin(), value.end(), [](wchar_t ch) {
        return (ch >= L'0' && ch <= L'9') || (ch >= L'a' && ch <= L'f');
    });
}

bool IsIdentity(const std::wstring& value) {
    const size_t separator = value.find(L':');
    if (separator == std::wstring::npos || separator == 0 || separator + 1 >= value.size() ||
        value.find(L':', separator + 1) != std::wstring::npos) return false;
    for (size_t i = 0; i < value.size(); ++i) {
        if (i == separator) continue;
        const wchar_t ch = value[i];
        if (!((ch >= L'0' && ch <= L'9') || (ch >= L'a' && ch <= L'f') ||
              (ch >= L'A' && ch <= L'F'))) return false;
    }
    return true;
}

bool IsSafeLabel(const std::wstring& value, size_t maximumLength) {
    return !value.empty() && value.size() <= maximumLength &&
        std::all_of(value.begin(), value.end(), [](wchar_t ch) {
            return IsAsciiAlphaNumeric(ch) || ch == L'_' || ch == L'-';
        });
}

bool IsRequestId(const std::wstring& value) {
    return value.size() >= 24 && value.size() <= 64 && IsSafeLabel(value, 64);
}

bool HasRequestIdSuffix(const std::wstring& fileName, const std::wstring& suffix) {
    if (fileName.size() <= suffix.size()) return false;
    const size_t idLength = fileName.size() - suffix.size();
    return IsRequestId(fileName.substr(0, idLength)) &&
        CompareStringOrdinal(fileName.c_str() + idLength, static_cast<int>(suffix.size()),
                             suffix.c_str(), static_cast<int>(suffix.size()), TRUE) == CSTR_EQUAL;
}

bool IsApprovalManifestForWorkspace(const Request& request) {
    const std::wstring stateRoot = ParentDirectory(ParentDirectory(ParentDirectory(request.tempRootPath)));
    if (stateRoot.empty()) return false;
    const std::wstring executionRoot = stateRoot.back() == L'\\'
        ? stateRoot + L"execution"
        : stateRoot + L"\\execution";
    const std::wstring workspaceId = request.tempWorkspaceId;
    const std::wstring level3Directory = executionRoot + L"\\level3\\" + workspaceId;
    const std::wstring gitPlansDirectory = executionRoot + L"\\git-plans\\" + workspaceId;
    const std::wstring manifestDirectory = ParentDirectory(request.approvalManifest);
    const std::wstring fileName = PathBasename(request.approvalManifest);
    if (SameOrdinal(manifestDirectory, level3Directory)) return HasRequestIdSuffix(fileName, L".manifest.json");
    if (SameOrdinal(manifestDirectory, gitPlansDirectory)) return HasRequestIdSuffix(fileName, L".json");
    return false;
}

bool ReadEnvironmentValue(const wchar_t* name, std::wstring& value, DWORD& error) {
    const DWORD needed = GetEnvironmentVariableW(name, nullptr, 0);
    if (needed == 0) {
        const DWORD readError = GetLastError();
        if (readError == ERROR_ENVVAR_NOT_FOUND || readError == ERROR_SUCCESS) {
            error = ERROR_SUCCESS;
            return false;
        }
        error = readError;
        return false;
    }
    if (needed > 32760) {
        error = ERROR_FILENAME_EXCED_RANGE;
        return false;
    }
    std::vector<wchar_t> buffer(static_cast<size_t>(needed) + 1, L'\0');
    const DWORD length = GetEnvironmentVariableW(name, buffer.data(), static_cast<DWORD>(buffer.size()));
    if (length == 0 || length >= buffer.size()) {
        error = length == 0 ? GetLastError() : ERROR_FILENAME_EXCED_RANGE;
        return false;
    }
    value.assign(buffer.data(), length);
    return true;
}

bool ParseUnsignedDecimal(const std::wstring& value, std::uint64_t& parsed) {
    if (value.empty()) return false;
    parsed = 0;
    for (wchar_t ch : value) {
        if (ch < L'0' || ch > L'9') return false;
        const std::uint64_t digit = static_cast<std::uint64_t>(ch - L'0');
        if (parsed > (UINT64_MAX - digit) / 10) return false;
        parsed = parsed * 10 + digit;
    }
    return true;
}

bool ValidateFullAccessRequestPaths(Request& request, DWORD& error) {
    if (!IsWorkspaceId(request.fullAccessWorkspaceId) || !IsRequestId(request.fullAccessJobId) ||
        request.oauthClientId.empty() || request.oauthClientId.size() > 200 ||
        request.permissionMode != L"level2" ||
        !IsHex(request.sessionGrantFingerprint, 64) || !IsHex(request.idempotencyKeyHash, 64) ||
        !IsHex(request.sessionGrantId, 64) || !IsHex(request.requestHash, 64) ||
        !IsIdentity(request.genericCwdFileIdentity) ||
        !IsIdentity(request.genericExecutableFileIdentity) || !IsHex(request.genericExecutableHash, 64) ||
        !IsIdentity(request.tempRootFileIdentity) || !IsIdentity(request.jobTempFileIdentity) ||
        !IsHex(request.tempNonce, 64) || request.tempCreatedAtMs.empty() ||
        request.tempCreatedAtMs.size() > 16) {
        error = ERROR_INVALID_DATA;
        return false;
    }
    std::uint64_t createdAtMs = 0;
    if (!ParseUnsignedDecimal(request.tempCreatedAtMs, createdAtMs)) {
        error = ERROR_INVALID_DATA;
        return false;
    }

    std::wstring canonical;
    if (!ValidateCanonicalPath(request.genericCwd, true, canonical, error)) return false;
    request.genericCwd = std::move(canonical);
    if (!ValidateCanonicalPath(request.genericExecutable, false, canonical, error)) return false;
    request.genericExecutable = std::move(canonical);
    if (!HasFullAccessExecutableExtension(request.genericExecutable) ||
        (request.genericMode != 1 && !HasExeExtension(request.genericExecutable))) {
        error = ERROR_INVALID_NAME;
        return false;
    }
    if (request.genericMode == 2 && !IsBasename(request.genericExecutable, L"cmd.exe")) {
        error = ERROR_INVALID_NAME;
        return false;
    } else if (request.genericMode == 3 &&
               !IsBasename(request.genericExecutable, L"powershell.exe") &&
               !IsBasename(request.genericExecutable, L"pwsh.exe")) {
        error = ERROR_INVALID_NAME;
        return false;
    } else if (request.genericMode != 1 && request.genericMode != 2 && request.genericMode != 3) {
        error = ERROR_INVALID_DATA;
        return false;
    }

    std::wstring expectedTempRoot;
    if (!ValidateCanonicalPath(request.tempRootPath, true, canonical, error)) return false;
    request.tempRootPath = std::move(canonical);
    if (!ExpectedExecutionTempRoot(request.fullAccessWorkspaceId, expectedTempRoot, error) ||
        !SameOrdinal(request.tempRootPath, expectedTempRoot)) {
        if (error == ERROR_SUCCESS) error = ERROR_ACCESS_DENIED;
        return false;
    }
    const std::wstring expectedJobTemp = request.tempRootPath + L"\\tmp-" + request.fullAccessJobId;
    if (!SameOrdinal(request.jobTempDir, expectedJobTemp) ||
        !ValidateCanonicalPath(request.jobTempDir, true, canonical, error)) {
        if (error == ERROR_SUCCESS) error = ERROR_INVALID_NAME;
        return false;
    }
    request.jobTempDir = std::move(canonical);
    return true;
}

bool ValidateRequestPaths(Request& request, DWORD& error) {
    if (request.recipe == 3) return ValidateFullAccessRequestPaths(request, error);
    if (request.hasFullAccessGrant && (request.recipe != 2 || request.kind != 5)) {
        error = ERROR_INVALID_DATA;
        return false;
    }

    if (!ValidateTarget(request)) {
        error = ERROR_INVALID_DATA;
        return false;
    }

    if (!IsBasename(request.nodeExecutable, L"node.exe") ||
        (request.manager == 1 && !IsBasename(request.managerCli, L"npm-cli.js")) ||
        (request.manager == 2 && !IsBasename(request.managerCli, L"pnpm.cjs"))) {
        error = ERROR_INVALID_NAME;
        return false;
    }

    std::wstring canonical;
    if (!ValidateCanonicalPath(request.cwd, true, canonical, error)) {
        return false;
    }
    request.cwd = std::move(canonical);
    if (request.recipe == 2) {
        if (!ValidateCanonicalPath(request.genericCwd, true, canonical, error)) return false;
        request.genericCwd = std::move(canonical);
        if (!IsPathWithinDirectory(request.cwd, request.genericCwd)) {
            error = ERROR_ACCESS_DENIED;
            return false;
        }
        if (!ValidateCanonicalPath(request.genericExecutable, false, canonical, error)) return false;
        request.genericExecutable = std::move(canonical);
        if (!HasExeExtension(request.genericExecutable)) {
            error = ERROR_INVALID_NAME;
            return false;
        }
        const bool powershellExecutable = IsBasename(request.genericExecutable, L"powershell.exe") ||
            IsBasename(request.genericExecutable, L"pwsh.exe");
        if ((request.genericMode == 3 && !powershellExecutable) ||
            (request.genericMode == 1 &&
             (IsBasename(request.genericExecutable, L"cmd.exe") || powershellExecutable))) {
            error = ERROR_INVALID_NAME;
            return false;
        }
        if (!ValidateCanonicalPath(request.approvalManifest, false, canonical, error)) return false;
        request.approvalManifest = std::move(canonical);
        for (auto& material : request.genericMaterials) {
            if (!ValidateCanonicalPath(material.path, false, canonical, error)) return false;
            material.path = std::move(canonical);
        }
        for (auto& material : request.launchSnapshots) {
            if (!ValidateCanonicalPath(material.path, false, canonical, error)) return false;
            material.path = std::move(canonical);
            if (!IsPathWithinDirectory(request.gitDirectory, material.path) && !IsPathWithinDirectory(request.commonGitDirectory, material.path)) {
                error = ERROR_ACCESS_DENIED; return false;
            }
        }
    }
    if (!ValidateCanonicalPath(request.gitDirectory, true, canonical, error)) {
        return false;
    }
    request.gitDirectory = std::move(canonical);
    if (!ValidateCanonicalPath(request.commonGitDirectory, true, canonical, error)) {
        return false;
    }
    request.commonGitDirectory = std::move(canonical);
    if (!ValidateCanonicalPath(request.nodeExecutable, false, canonical, error)) {
        return false;
    }
    request.nodeExecutable = std::move(canonical);
    if (!ValidateCanonicalPath(request.managerCli, false, canonical, error)) {
        return false;
    }
    request.managerCli = std::move(canonical);
    const auto parentDirectory = [](const std::wstring& file) {
        const size_t separator = file.find_last_of(L'\\');
        return separator == 2 ? file.substr(0, 3) : file.substr(0, separator);
    };
    const auto canonicalManagerPath = [&](std::wstring& file) {
        if (!ValidateCanonicalPath(file, false, canonical, error)) return false;
        file = std::move(canonical);
        return true;
    };
    if (!canonicalManagerPath(request.managerLibCli) ||
        !canonicalManagerPath(request.managerValidateEngines) ||
        !canonicalManagerPath(request.managerMainEntry) ||
        !canonicalManagerPath(request.managerPackageJson) ||
        !canonicalManagerPath(request.managerExitHandler) ||
        !canonicalManagerPath(request.managerCore)) return false;
    if (request.manager == 1) {
        const std::wstring npmRoot = parentDirectory(parentDirectory(request.managerCli));
        const std::wstring expectedLibCli = npmRoot + L"\\lib\\cli.js";
        const std::wstring expectedValidateEngines = npmRoot + L"\\lib\\cli\\validate-engines.js";
        const std::wstring expectedMainEntry = npmRoot + L"\\lib\\cli\\entry.js";
        const std::wstring expectedPackageJson = npmRoot + L"\\package.json";
        const std::wstring expectedExitHandler = npmRoot + L"\\lib\\cli\\exit-handler.js";
        const std::wstring expectedCore = npmRoot + L"\\lib\\npm.js";
        if (CompareStringOrdinal(request.managerLibCli.c_str(), -1, expectedLibCli.c_str(), -1, TRUE) != CSTR_EQUAL ||
            CompareStringOrdinal(request.managerValidateEngines.c_str(), -1, expectedValidateEngines.c_str(), -1, TRUE) != CSTR_EQUAL ||
            CompareStringOrdinal(request.managerMainEntry.c_str(), -1, expectedMainEntry.c_str(), -1, TRUE) != CSTR_EQUAL ||
            CompareStringOrdinal(request.managerPackageJson.c_str(), -1, expectedPackageJson.c_str(), -1, TRUE) != CSTR_EQUAL ||
            CompareStringOrdinal(request.managerExitHandler.c_str(), -1, expectedExitHandler.c_str(), -1, TRUE) != CSTR_EQUAL ||
            CompareStringOrdinal(request.managerCore.c_str(), -1, expectedCore.c_str(), -1, TRUE) != CSTR_EQUAL) {
            error = ERROR_INVALID_NAME;
            return false;
        }
    } else {
        // pnpm 11's fixed CJS compatibility entry imports bin/pnpm.mjs,
        // which in turn imports the bundled dist/pnpm.mjs implementation.
        const std::wstring pnpmRoot = parentDirectory(parentDirectory(request.managerCli));
        const std::wstring expectedCli = pnpmRoot + L"\\bin\\pnpm.cjs";
        const std::wstring expectedLauncher = pnpmRoot + L"\\bin\\pnpm.mjs";
        const std::wstring expectedBundle = pnpmRoot + L"\\dist\\pnpm.mjs";
        if (!SameOrdinal(request.managerCli, expectedCli) ||
            !SameOrdinal(request.managerLibCli, expectedLauncher) ||
            !SameOrdinal(request.managerValidateEngines, expectedBundle) ||
            !SameOrdinal(request.managerMainEntry, expectedBundle) ||
            !SameOrdinal(request.managerPackageJson, pnpmRoot + L"\\package.json") ||
            !SameOrdinal(request.managerExitHandler, expectedLauncher) ||
            !SameOrdinal(request.managerCore, expectedBundle) ||
            !SameOrdinal(request.managerLibCliFileIdentity, request.managerExitHandlerFileIdentity) ||
            !SameOrdinal(request.managerLibCliHash, request.managerExitHandlerHash) ||
            !SameOrdinal(request.managerValidateEnginesFileIdentity, request.managerMainEntryFileIdentity) ||
            !SameOrdinal(request.managerValidateEnginesHash, request.managerMainEntryHash) ||
            !SameOrdinal(request.managerValidateEnginesFileIdentity, request.managerCoreFileIdentity) ||
            !SameOrdinal(request.managerValidateEnginesHash, request.managerCoreHash)) {
            error = ERROR_INVALID_NAME;
            return false;
        }
    }
    if (!ValidateCanonicalPath(request.gitEntryType == 2
                                   ? request.cwd + L"\\.git"
                                   : request.cwd + L"\\.git",
                               request.gitEntryType == 2, canonical, error)) {
        return false;
    }
    if (!ValidateCanonicalPath(request.tempRootPath, true, canonical, error)) {
        return false;
    }
    request.tempRootPath = std::move(canonical);
    if (!IsBasename(request.tempRootPath, L"execution-temp") ||
        !IsSafeLabel(request.tempWorkspaceId, 128) ||
        !IsSafeLabel(request.tempJobId, 64) || request.tempJobId.size() < 24 ||
        !IsHex(request.tempNonce, 64) || !IsIdentity(request.tempRootFileIdentity) ||
        !IsIdentity(request.jobTempFileIdentity) || request.tempCreatedAtMs.empty() ||
        request.tempCreatedAtMs.size() > 16 ||
        !std::all_of(request.tempCreatedAtMs.begin(), request.tempCreatedAtMs.end(), [](wchar_t ch) {
            return ch >= L'0' && ch <= L'9';
        })) {
        error = ERROR_INVALID_DATA;
        return false;
    }
    std::wstring expectedTempRoot;
    if (!ExpectedExecutionTempRoot(request.tempWorkspaceId, expectedTempRoot, error) ||
        !SameOrdinal(request.tempRootPath, expectedTempRoot)) {
        if (error == ERROR_SUCCESS) error = ERROR_ACCESS_DENIED;
        return false;
    }
    if (request.recipe == 2 && !IsApprovalManifestForWorkspace(request)) {
        error = ERROR_ACCESS_DENIED;
        return false;
    }
    const std::wstring expectedTempPath = request.tempRootPath + L"\\tmp-" + request.tempJobId;
    if (CompareStringOrdinal(request.jobTempDir.c_str(), -1,
                             expectedTempPath.c_str(), -1, TRUE) != CSTR_EQUAL) {
        error = ERROR_INVALID_NAME;
        return false;
    }
    if (!ValidateCanonicalPath(request.jobTempDir, true, canonical, error)) {
        return false;
    }
    request.jobTempDir = std::move(canonical);
    return true;
}

bool SameOrdinal(const std::wstring& left, const std::wstring& right) {
    return CompareStringOrdinal(left.c_str(), -1, right.c_str(), -1, TRUE) == CSTR_EQUAL;
}

bool FileIdentity(HANDLE handle, std::wstring& identity, DWORD& error) {
    BY_HANDLE_FILE_INFORMATION info{};
    if (!GetFileInformationByHandle(handle, &info)) {
        error = GetLastError();
        return false;
    }
    const std::uint64_t index =
        (static_cast<std::uint64_t>(info.nFileIndexHigh) << 32) | info.nFileIndexLow;
    std::wostringstream value;
    value << std::hex << std::nouppercase << info.dwVolumeSerialNumber << L":" << index;
    identity = value.str();
    return true;
}

bool DirectoryAttributes(HANDLE handle, DWORD& error) {
    FILE_ATTRIBUTE_TAG_INFO info{};
    if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &info, sizeof(info))) {
        error = GetLastError();
        return false;
    }
    if ((info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
        error = ERROR_REPARSE_TAG_INVALID;
        return false;
    }
    if ((info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0) {
        error = ERROR_DIRECTORY;
        return false;
    }
    return true;
}

bool OpenDirectoryLock(const std::wstring& path, const std::wstring* expectedIdentity,
                       std::vector<UniqueHandle>& locks, DWORD& error,
                       bool blockConcurrentWrites) {
    const DWORD shareMode = FILE_SHARE_READ |
        (blockConcurrentWrites ? 0 : FILE_SHARE_WRITE);
    UniqueHandle handle(CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES,
                                    shareMode, nullptr, OPEN_EXISTING,
                                    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                                    nullptr));
    if (!handle.valid()) {
        error = GetLastError();
        return false;
    }
    if (!DirectoryAttributes(handle.get(), error)) return false;
    if (expectedIdentity != nullptr) {
        std::wstring actual;
        if (!FileIdentity(handle.get(), actual, error) || !SameOrdinal(actual, *expectedIdentity)) {
            if (error == ERROR_SUCCESS) error = ERROR_FILE_INVALID;
            return false;
        }
    }
    locks.push_back(std::move(handle));
    return true;
}

bool LockDirectoryPath(const std::wstring& path, const std::wstring* expectedIdentity,
                       std::vector<UniqueHandle>& locks, DWORD& error,
                       bool blockConcurrentWrites = false) {
    if (!IsAsciiDriveAbsolutePath(path)) {
        error = ERROR_INVALID_NAME;
        return false;
    }
    std::wstring componentPath = path.substr(0, 3);
    if (!OpenDirectoryLock(componentPath, nullptr, locks, error, blockConcurrentWrites)) return false;
    size_t cursor = 3;
    while (cursor < path.size()) {
        const size_t separator = path.find(L'\\', cursor);
        const size_t end = separator == std::wstring::npos ? path.size() : separator;
        componentPath += path.substr(cursor, end - cursor);
        const bool finalComponent = end == path.size();
        if (!OpenDirectoryLock(componentPath,
                               finalComponent ? expectedIdentity : nullptr,
                               locks, error, blockConcurrentWrites)) {
            return false;
        }
        if (!finalComponent) componentPath.push_back(L'\\');
        cursor = end + 1;
    }
    return true;
}

bool Sha256(HANDLE file, std::wstring& hex, DWORD& error) {
    BCRYPT_ALG_HANDLE algorithm = nullptr;
    BCRYPT_HASH_HANDLE hash = nullptr;
    DWORD objectLength = 0;
    DWORD digestLength = 0;
    DWORD resultLength = 0;
    NTSTATUS status = BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0);
    if (!BCRYPT_SUCCESS(status)) {
        error = ERROR_GEN_FAILURE;
        return false;
    }
    status = BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH,
                               reinterpret_cast<PUCHAR>(&objectLength), sizeof(objectLength),
                               &resultLength, 0);
    if (!BCRYPT_SUCCESS(status)) {
        error = ERROR_GEN_FAILURE;
        BCryptCloseAlgorithmProvider(algorithm, 0);
        return false;
    }
    status = BCryptGetProperty(algorithm, BCRYPT_HASH_LENGTH,
                               reinterpret_cast<PUCHAR>(&digestLength), sizeof(digestLength),
                               &resultLength, 0);
    if (!BCRYPT_SUCCESS(status) || digestLength != 32) {
        error = ERROR_GEN_FAILURE;
        BCryptCloseAlgorithmProvider(algorithm, 0);
        return false;
    }
    std::vector<BYTE> object(objectLength);
    std::vector<BYTE> digest(digestLength);
    status = BCryptCreateHash(algorithm, &hash, object.data(), objectLength, nullptr, 0, 0);
    if (!BCRYPT_SUCCESS(status)) {
        error = ERROR_GEN_FAILURE;
        BCryptCloseAlgorithmProvider(algorithm, 0);
        return false;
    }
    LARGE_INTEGER beginning{};
    if (!SetFilePointerEx(file, beginning, nullptr, FILE_BEGIN)) {
        error = GetLastError();
        BCryptDestroyHash(hash);
        BCryptCloseAlgorithmProvider(algorithm, 0);
        return false;
    }
    std::vector<BYTE> buffer(64 * 1024);
    for (;;) {
        DWORD received = 0;
        if (!ReadFile(file, buffer.data(), static_cast<DWORD>(buffer.size()), &received, nullptr)) {
            error = GetLastError();
            BCryptDestroyHash(hash);
            BCryptCloseAlgorithmProvider(algorithm, 0);
            return false;
        }
        if (received == 0) break;
        status = BCryptHashData(hash, buffer.data(), received, 0);
        if (!BCRYPT_SUCCESS(status)) {
            error = ERROR_GEN_FAILURE;
            BCryptDestroyHash(hash);
            BCryptCloseAlgorithmProvider(algorithm, 0);
            return false;
        }
    }
    status = BCryptFinishHash(hash, digest.data(), digestLength, 0);
    BCryptDestroyHash(hash);
    BCryptCloseAlgorithmProvider(algorithm, 0);
    if (!BCRYPT_SUCCESS(status)) {
        error = ERROR_GEN_FAILURE;
        return false;
    }
    std::wostringstream value;
    value << std::hex << std::nouppercase;
    for (BYTE byte : digest) {
        value.width(2);
        value.fill(L'0');
        value << static_cast<unsigned int>(byte);
    }
    hex = value.str();
    return true;
}

bool OpenFileLock(const std::wstring& path, const std::wstring* expectedIdentity,
                  const std::wstring* expectedHash, std::vector<UniqueHandle>& locks,
                  DWORD& error) {
    UniqueHandle handle(CreateFileW(path.c_str(), GENERIC_READ | FILE_READ_ATTRIBUTES,
                                    FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                                    FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    if (!handle.valid()) {
        error = GetLastError();
        return false;
    }
    FILE_ATTRIBUTE_TAG_INFO info{};
    if (!GetFileInformationByHandleEx(handle.get(), FileAttributeTagInfo,
                                      &info, sizeof(info))) {
        error = GetLastError();
        return false;
    }
    if ((info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 ||
        (info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) {
        error = ERROR_REPARSE_TAG_INVALID;
        return false;
    }
    if (expectedIdentity != nullptr) {
        std::wstring actualIdentity;
        if (!FileIdentity(handle.get(), actualIdentity, error) ||
            !SameOrdinal(actualIdentity, *expectedIdentity)) {
            if (error == ERROR_SUCCESS) error = ERROR_FILE_INVALID;
            return false;
        }
    }
    if (expectedHash != nullptr) {
        std::wstring actualHash;
        if (!Sha256(handle.get(), actualHash, error) || !SameOrdinal(actualHash, *expectedHash)) {
            if (error == ERROR_SUCCESS) error = ERROR_CRC;
            return false;
        }
    }
    locks.push_back(std::move(handle));
    return true;
}

void WriteHelperFailureDiagnostic(const char* stage, DWORD error);

bool AccessBlockedByMaterialLock(const std::wstring& path, DWORD& error) {
    // Probe for the held read handle without requiring write permission on the
    // runtime installation. Request data-read access (not just attributes) and
    // omit FILE_SHARE_READ so the probe conflicts with the helper's live lock.
    UniqueHandle probe(CreateFileW(path.c_str(), GENERIC_READ,
                                  FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                                  nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
    if (probe.valid()) {
        error = ERROR_SHARING_VIOLATION;
        return false;
    }
    const DWORD openError = GetLastError();
    if (openError == ERROR_SHARING_VIOLATION) return true;
    error = openError;
    return false;
}

bool VerifyRuntimeMaterialLocks(const Request& request, DWORD& error) {
    const std::wstring* const paths[] = {
        &request.nodeExecutable,
        &request.managerCli,
        &request.managerLibCli,
        &request.managerValidateEngines,
        &request.managerMainEntry,
        &request.managerPackageJson,
        &request.managerExitHandler,
        &request.managerCore,
    };
    for (size_t index = 0; index < std::size(paths); ++index) {
        if (!AccessBlockedByMaterialLock(*paths[index], error)) {
            const std::string stage = "runtime-lock-probe-allowed-material-" + std::to_string(index);
            WriteHelperFailureDiagnostic(stage.c_str(), error);
            return false;
        }
    }
    return true;
}

bool ToAscii(const std::wstring& value, std::string& output) {
    output.clear();
    output.reserve(value.size());
    for (wchar_t ch : value) {
        if (ch < 0 || ch > 0x7f) return false;
        output.push_back(static_cast<char>(ch));
    }
    return true;
}

bool OpenMatchingMarkerFile(const std::wstring& path, const std::string& expected,
                            DWORD desiredAccess, UniqueHandle& file, DWORD& error) {
    file.reset(CreateFileW(path.c_str(), desiredAccess | FILE_READ_ATTRIBUTES,
                           FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                           FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    if (!file.valid()) {
        error = GetLastError();
        return false;
    }
    FILE_ATTRIBUTE_TAG_INFO attributes{};
    LARGE_INTEGER size{};
    if (!GetFileInformationByHandleEx(file.get(), FileAttributeTagInfo,
                                      &attributes, sizeof(attributes)) ||
        !GetFileSizeEx(file.get(), &size)) {
        error = GetLastError();
        return false;
    }
    if ((attributes.FileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)) != 0 ||
        size.QuadPart < 0 || static_cast<std::uint64_t>(size.QuadPart) != expected.size()) {
        error = ERROR_INVALID_DATA;
        return false;
    }
    std::string actual(expected.size(), '\0');
    DWORD received = 0;
    if (!ReadFile(file.get(), actual.data(), static_cast<DWORD>(actual.size()), &received, nullptr) ||
        received != actual.size() || actual != expected) {
        error = GetLastError();
        if (error == ERROR_SUCCESS) error = ERROR_INVALID_DATA;
        return false;
    }
    return true;
}

bool MatchesMarkerFile(const std::wstring& path, const std::string& expected, DWORD& error) {
    UniqueHandle file;
    return OpenMatchingMarkerFile(path, expected, GENERIC_READ, file, error);
}

void SkipJsonWhitespace(const std::string& json, size_t& cursor) {
    while (cursor < json.size() && (json[cursor] == ' ' || json[cursor] == '\t' ||
           json[cursor] == '\r' || json[cursor] == '\n')) ++cursor;
}

void AppendUtf8CodePoint(std::uint32_t codePoint, std::string& value) {
    if (codePoint <= 0x7f) {
        value.push_back(static_cast<char>(codePoint));
    } else if (codePoint <= 0x7ff) {
        value.push_back(static_cast<char>(0xc0 | (codePoint >> 6)));
        value.push_back(static_cast<char>(0x80 | (codePoint & 0x3f)));
    } else if (codePoint <= 0xffff) {
        value.push_back(static_cast<char>(0xe0 | (codePoint >> 12)));
        value.push_back(static_cast<char>(0x80 | ((codePoint >> 6) & 0x3f)));
        value.push_back(static_cast<char>(0x80 | (codePoint & 0x3f)));
    } else {
        value.push_back(static_cast<char>(0xf0 | (codePoint >> 18)));
        value.push_back(static_cast<char>(0x80 | ((codePoint >> 12) & 0x3f)));
        value.push_back(static_cast<char>(0x80 | ((codePoint >> 6) & 0x3f)));
        value.push_back(static_cast<char>(0x80 | (codePoint & 0x3f)));
    }
}

bool ReadJsonHexCodeUnit(const std::string& json, size_t& cursor, std::uint32_t& value) {
    if (cursor + 4 > json.size()) return false;
    value = 0;
    for (size_t index = 0; index < 4; ++index) {
        const char ch = json[cursor++];
        std::uint32_t digit = 0;
        if (ch >= '0' && ch <= '9') digit = static_cast<std::uint32_t>(ch - '0');
        else if (ch >= 'a' && ch <= 'f') digit = static_cast<std::uint32_t>(ch - 'a' + 10);
        else if (ch >= 'A' && ch <= 'F') digit = static_cast<std::uint32_t>(ch - 'A' + 10);
        else return false;
        value = (value << 4) | digit;
    }
    return true;
}

bool ParseJsonString(const std::string& json, size_t& cursor, std::string& value) {
    if (cursor >= json.size() || json[cursor++] != '"') return false;
    value.clear();
    while (cursor < json.size()) {
        const unsigned char ch = static_cast<unsigned char>(json[cursor++]);
        if (ch == '"') return true;
        if (ch < 0x20) return false;
        if (ch != '\\') {
            value.push_back(static_cast<char>(ch));
            continue;
        }
        if (cursor >= json.size()) return false;
        switch (json[cursor++]) {
            case '"': value.push_back('"'); break;
            case '\\': value.push_back('\\'); break;
            case '/': value.push_back('/'); break;
            case 'b': value.push_back('\b'); break;
            case 'f': value.push_back('\f'); break;
            case 'n': value.push_back('\n'); break;
            case 'r': value.push_back('\r'); break;
            case 't': value.push_back('\t'); break;
            case 'u': {
                std::uint32_t codePoint = 0;
                if (!ReadJsonHexCodeUnit(json, cursor, codePoint)) return false;
                if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
                    if (cursor + 2 > json.size() || json[cursor] != '\\' || json[cursor + 1] != 'u') return false;
                    cursor += 2;
                    std::uint32_t low = 0;
                    if (!ReadJsonHexCodeUnit(json, cursor, low) || low < 0xdc00 || low > 0xdfff) return false;
                    codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (low - 0xdc00);
                } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
                    return false;
                }
                AppendUtf8CodePoint(codePoint, value);
                break;
            }
            default: return false;
        }
    }
    return false;
}

bool SkipJsonNumber(const std::string& json, size_t& cursor) {
    if (cursor < json.size() && json[cursor] == '-') ++cursor;
    if (cursor >= json.size()) return false;
    if (json[cursor] == '0') {
        ++cursor;
        if (cursor < json.size() && json[cursor] >= '0' && json[cursor] <= '9') return false;
    } else if (json[cursor] >= '1' && json[cursor] <= '9') {
        while (cursor < json.size() && json[cursor] >= '0' && json[cursor] <= '9') ++cursor;
    } else {
        return false;
    }
    if (cursor < json.size() && json[cursor] == '.') {
        ++cursor;
        const size_t fractionStart = cursor;
        while (cursor < json.size() && json[cursor] >= '0' && json[cursor] <= '9') ++cursor;
        if (cursor == fractionStart) return false;
    }
    if (cursor < json.size() && (json[cursor] == 'e' || json[cursor] == 'E')) {
        ++cursor;
        if (cursor < json.size() && (json[cursor] == '+' || json[cursor] == '-')) ++cursor;
        const size_t exponentStart = cursor;
        while (cursor < json.size() && json[cursor] >= '0' && json[cursor] <= '9') ++cursor;
        if (cursor == exponentStart) return false;
    }
    return true;
}

bool SkipJsonValue(const std::string& json, size_t& cursor, unsigned depth) {
    if (depth > 32) return false;
    SkipJsonWhitespace(json, cursor);
    if (cursor >= json.size()) return false;
    if (json[cursor] == '"') {
        std::string ignored;
        return ParseJsonString(json, cursor, ignored);
    }
    if (json[cursor] == '{') {
        ++cursor;
        SkipJsonWhitespace(json, cursor);
        if (cursor < json.size() && json[cursor] == '}') { ++cursor; return true; }
        for (;;) {
            std::string key;
            if (!ParseJsonString(json, cursor, key)) return false;
            SkipJsonWhitespace(json, cursor);
            if (cursor >= json.size() || json[cursor++] != ':') return false;
            if (!SkipJsonValue(json, cursor, depth + 1)) return false;
            SkipJsonWhitespace(json, cursor);
            if (cursor >= json.size()) return false;
            if (json[cursor] == '}') { ++cursor; return true; }
            if (json[cursor++] != ',') return false;
            SkipJsonWhitespace(json, cursor);
        }
    }
    if (json[cursor] == '[') {
        ++cursor;
        SkipJsonWhitespace(json, cursor);
        if (cursor < json.size() && json[cursor] == ']') { ++cursor; return true; }
        for (;;) {
            if (!SkipJsonValue(json, cursor, depth + 1)) return false;
            SkipJsonWhitespace(json, cursor);
            if (cursor >= json.size()) return false;
            if (json[cursor] == ']') { ++cursor; return true; }
            if (json[cursor++] != ',') return false;
        }
    }
    if (json.compare(cursor, 4, "true") == 0) { cursor += 4; return true; }
    if (json.compare(cursor, 5, "false") == 0) { cursor += 5; return true; }
    if (json.compare(cursor, 4, "null") == 0) { cursor += 4; return true; }
    return SkipJsonNumber(json, cursor);
}

bool ReadJsonObjectMemberPrefix(const std::string& json, size_t& cursor, std::string& key) {
    if (!ParseJsonString(json, cursor, key)) return false;
    SkipJsonWhitespace(json, cursor);
    return cursor < json.size() && json[cursor++] == ':';
}

bool IsCanonicalIsoTimestamp(const std::string& value) {
    if (value.size() != 24 || value[4] != '-' || value[7] != '-' || value[10] != 'T' ||
        value[13] != ':' || value[16] != ':' || value[19] != '.' || value[23] != 'Z') return false;
    const auto digits = [&value](size_t offset, size_t count, unsigned& result) {
        result = 0;
        for (size_t index = 0; index < count; ++index) {
            const char ch = value[offset + index];
            if (ch < '0' || ch > '9') return false;
            result = result * 10 + static_cast<unsigned>(ch - '0');
        }
        return true;
    };
    unsigned year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0, millis = 0;
    if (!digits(0, 4, year) || !digits(5, 2, month) || !digits(8, 2, day) ||
        !digits(11, 2, hour) || !digits(14, 2, minute) || !digits(17, 2, second) ||
        !digits(20, 3, millis) || month < 1 || month > 12 || hour > 23 ||
        minute > 59 || second > 59 || millis > 999) return false;
    const bool leapYear = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    const unsigned daysInMonth[] = { 31, leapYear ? 29u : 28u, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 };
    return day >= 1 && day <= daysInMonth[month - 1];
}

struct ParsedPermissionGrant {
    std::string identityFingerprint;
    std::string grantId;
    std::string createdAt;
    bool hasIdentityFingerprint = false;
    bool hasGrantId = false;
    bool hasCreatedAt = false;
};

bool ParsePermissionGrant(const std::string& json, size_t& cursor, ParsedPermissionGrant& grant) {
    SkipJsonWhitespace(json, cursor);
    if (cursor >= json.size() || json[cursor++] != '{') return false;
    SkipJsonWhitespace(json, cursor);
    if (cursor < json.size() && json[cursor] == '}') { ++cursor; return false; }
    for (;;) {
        std::string key;
        if (!ReadJsonObjectMemberPrefix(json, cursor, key)) return false;
        SkipJsonWhitespace(json, cursor);
        if (key == "identityFingerprint") {
            if (grant.hasIdentityFingerprint || !ParseJsonString(json, cursor, grant.identityFingerprint)) return false;
            grant.hasIdentityFingerprint = true;
        } else if (key == "grantId") {
            if (grant.hasGrantId || !ParseJsonString(json, cursor, grant.grantId)) return false;
            grant.hasGrantId = true;
        } else if (key == "createdAt") {
            if (grant.hasCreatedAt || !ParseJsonString(json, cursor, grant.createdAt)) return false;
            grant.hasCreatedAt = true;
        } else if (!SkipJsonValue(json, cursor, 2)) {
            return false;
        }
        SkipJsonWhitespace(json, cursor);
        if (cursor >= json.size()) return false;
        if (json[cursor] == '}') { ++cursor; break; }
        if (json[cursor++] != ',') return false;
        SkipJsonWhitespace(json, cursor);
    }
    return grant.hasIdentityFingerprint && grant.hasGrantId && grant.hasCreatedAt &&
        IsCanonicalIsoTimestamp(grant.createdAt);
}

struct ParsedPermissionState {
    std::string version;
    std::string workspaceId;
    std::string baselineMode;
    std::string updatedAt;
    ParsedPermissionGrant sessionGrant;
    bool hasVersion = false;
    bool hasWorkspaceId = false;
    bool hasBaselineMode = false;
    bool hasUpdatedAt = false;
    bool hasSessionGrant = false;
};

bool ParsePermissionState(const std::string& json, ParsedPermissionState& state) {
    size_t cursor = 0;
    SkipJsonWhitespace(json, cursor);
    if (cursor >= json.size() || json[cursor++] != '{') return false;
    SkipJsonWhitespace(json, cursor);
    if (cursor < json.size() && json[cursor] == '}') return false;
    for (;;) {
        std::string key;
        if (!ReadJsonObjectMemberPrefix(json, cursor, key)) return false;
        SkipJsonWhitespace(json, cursor);
        if (key == "version") {
            if (state.hasVersion || cursor >= json.size() || json[cursor] != '2') return false;
            ++cursor;
            if (cursor < json.size() && (json[cursor] == '.' || json[cursor] == 'e' || json[cursor] == 'E' ||
                (json[cursor] >= '0' && json[cursor] <= '9'))) return false;
            state.version = "2";
            state.hasVersion = true;
        } else if (key == "workspaceId") {
            if (state.hasWorkspaceId || !ParseJsonString(json, cursor, state.workspaceId)) return false;
            state.hasWorkspaceId = true;
        } else if (key == "baselineMode") {
            if (state.hasBaselineMode || !ParseJsonString(json, cursor, state.baselineMode)) return false;
            state.hasBaselineMode = true;
        } else if (key == "updatedAt") {
            if (state.hasUpdatedAt || !ParseJsonString(json, cursor, state.updatedAt)) return false;
            state.hasUpdatedAt = true;
        } else if (key == "sessionGrant") {
            if (state.hasSessionGrant || !ParsePermissionGrant(json, cursor, state.sessionGrant)) return false;
            state.hasSessionGrant = true;
        } else if (!SkipJsonValue(json, cursor, 1)) {
            return false;
        }
        SkipJsonWhitespace(json, cursor);
        if (cursor >= json.size()) return false;
        if (json[cursor] == '}') { ++cursor; break; }
        if (json[cursor++] != ',') return false;
        SkipJsonWhitespace(json, cursor);
    }
    SkipJsonWhitespace(json, cursor);
    return cursor == json.size() && state.hasVersion && state.hasWorkspaceId &&
        state.hasBaselineMode && state.hasUpdatedAt && !state.updatedAt.empty() &&
        state.hasSessionGrant;
}

bool ExpectedPermissionStatePaths(const Request& request, std::wstring& statePath,
                                  std::wstring& lockPath, DWORD& error) {
    std::wstring stateRoot;
    if (!ReadEnvironmentValue(L"C2C_STATE_DIR", stateRoot, error)) {
        if (error != ERROR_SUCCESS) return false;
        std::wstring localAppData;
        if (!ReadEnvironmentValue(L"LOCALAPPDATA", localAppData, error)) {
            if (error != ERROR_SUCCESS) return false;
            std::wstring profile;
            if (!ReadEnvironmentValue(L"USERPROFILE", profile, error) || error != ERROR_SUCCESS) {
                if (error == ERROR_SUCCESS) error = ERROR_PATH_NOT_FOUND;
                return false;
            }
            localAppData = profile + L"\\AppData\\Local";
        }
        stateRoot = localAppData + L"\\OpenAI\\c2c-local";
    }
    std::wstring canonicalRoot;
    if (!ValidateCanonicalPath(stateRoot, true, canonicalRoot, error)) return false;
    std::wstring canonicalPermissionDirectory;
    if (!ValidateCanonicalPath(canonicalRoot + L"\\permissions", true,
                               canonicalPermissionDirectory, error)) return false;
    statePath = canonicalPermissionDirectory + L"\\" + request.fullAccessWorkspaceId + L".json";
    lockPath = statePath + L".lock";
    return true;
}

bool Sha256Text(const std::string& value, std::string& hex) {
    BCRYPT_ALG_HANDLE algorithm = nullptr;
    BCRYPT_HASH_HANDLE hash = nullptr;
    DWORD objectLength = 0;
    DWORD digestLength = 0;
    DWORD resultLength = 0;
    NTSTATUS status = BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0);
    if (!BCRYPT_SUCCESS(status)) return false;
    status = BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH,
                               reinterpret_cast<PUCHAR>(&objectLength), sizeof(objectLength),
                               &resultLength, 0);
    if (!BCRYPT_SUCCESS(status)) { BCryptCloseAlgorithmProvider(algorithm, 0); return false; }
    status = BCryptGetProperty(algorithm, BCRYPT_HASH_LENGTH,
                               reinterpret_cast<PUCHAR>(&digestLength), sizeof(digestLength),
                               &resultLength, 0);
    if (!BCRYPT_SUCCESS(status) || digestLength != 32) {
        BCryptCloseAlgorithmProvider(algorithm, 0);
        return false;
    }
    std::vector<BYTE> object(objectLength);
    std::array<BYTE, 32> digest{};
    status = BCryptCreateHash(algorithm, &hash, object.data(), objectLength, nullptr, 0, 0);
    if (BCRYPT_SUCCESS(status)) {
        status = BCryptHashData(hash, reinterpret_cast<PUCHAR>(const_cast<char*>(value.data())),
                                static_cast<ULONG>(value.size()), 0);
    }
    if (BCRYPT_SUCCESS(status)) {
        status = BCryptFinishHash(hash, digest.data(), static_cast<ULONG>(digest.size()), 0);
    }
    if (hash) BCryptDestroyHash(hash);
    BCryptCloseAlgorithmProvider(algorithm, 0);
    if (!BCRYPT_SUCCESS(status)) return false;
    std::ostringstream output;
    output << std::hex << std::nouppercase << std::setfill('0');
    for (BYTE byte : digest) output << std::setw(2) << static_cast<unsigned int>(byte);
    hex = output.str();
    return true;
}

bool CurrentWindowsSessionFingerprint(std::string& fingerprint, DWORD& error) {
    using NtQuerySystemInformationFn = LONG (NTAPI*)(ULONG, PVOID, ULONG, PULONG);
    HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
    auto query = ntdll ? reinterpret_cast<NtQuerySystemInformationFn>(
        GetProcAddress(ntdll, "NtQuerySystemInformation")) : nullptr;
    if (!query) { error = ERROR_PROC_NOT_FOUND; return false; }
    const auto queryExact = [query](ULONG informationClass, BYTE* bytes, ULONG size) {
        ULONG returned = 0;
        const LONG status = query(informationClass, bytes, size, &returned);
        return status >= 0 && returned == size;
    };

    std::array<BYTE, 32> environment{};
    GUID bootIdentifier{};
    bool hasBootIdentifier = false;
    bool hasExtendedEnvironment = false;
    std::uint64_t bootTimeFileTicks = 0;
    for (ULONG informationClass : { 107u, 90u }) {
        environment.fill(0xAA);
        if (!queryExact(informationClass, environment.data(),
                        static_cast<ULONG>(environment.size()))) continue;
        GUID candidate{};
        std::memcpy(&candidate, environment.data(), sizeof(candidate));
        std::uint64_t candidateBootTime = 0;
        std::memcpy(&candidateBootTime, environment.data() + 24, sizeof(candidateBootTime));
        const bool emptyGuid = candidate.Data1 == 0 && candidate.Data2 == 0 && candidate.Data3 == 0 &&
            std::all_of(std::begin(candidate.Data4), std::end(candidate.Data4), [](BYTE value) { return value == 0; });
        if (informationClass == 90u && !emptyGuid) {
            bootIdentifier = candidate;
            hasBootIdentifier = true;
        }
        if (emptyGuid || candidateBootTime == 0 || candidateBootTime >= 2650467743999999999ULL) continue;
        bootIdentifier = candidate;
        hasBootIdentifier = true;
        bootTimeFileTicks = candidateBootTime;
        hasExtendedEnvironment = true;
        break;
    }

    std::array<BYTE, 48> timeOfDay{};
    timeOfDay.fill(0xAA);
    bool hasTimeOfDayBoot = false;
    std::uint64_t timeOfDayBootTicks = 0;
    if (queryExact(3u, timeOfDay.data(), static_cast<ULONG>(timeOfDay.size()))) {
        std::memcpy(&timeOfDayBootTicks, timeOfDay.data(), sizeof(timeOfDayBootTicks));
        hasTimeOfDayBoot = timeOfDayBootTicks > 0 && timeOfDayBootTicks < 2650467743999999999ULL;
    }
    if (hasExtendedEnvironment) {
        if (hasTimeOfDayBoot && timeOfDayBootTicks != bootTimeFileTicks) {
            error = ERROR_INVALID_DATA;
            return false;
        }
    } else {
        if (!hasTimeOfDayBoot) { error = ERROR_NOT_SUPPORTED; return false; }
        if (!hasBootIdentifier) {
            environment.fill(0xAA);
            if (!queryExact(90u, environment.data(), static_cast<ULONG>(environment.size()))) {
                error = ERROR_NOT_SUPPORTED;
                return false;
            }
            std::memcpy(&bootIdentifier, environment.data(), sizeof(bootIdentifier));
            const bool emptyGuid = bootIdentifier.Data1 == 0 && bootIdentifier.Data2 == 0 && bootIdentifier.Data3 == 0 &&
                std::all_of(std::begin(bootIdentifier.Data4), std::end(bootIdentifier.Data4), [](BYTE value) { return value == 0; });
            if (emptyGuid) { error = ERROR_NOT_SUPPORTED; return false; }
            hasBootIdentifier = true;
        }
        bootTimeFileTicks = timeOfDayBootTicks;
    }
    std::ostringstream bootIdText;
    bootIdText << std::hex << std::nouppercase << std::setfill('0')
        << std::setw(8) << bootIdentifier.Data1 << '-'
        << std::setw(4) << bootIdentifier.Data2 << '-'
        << std::setw(4) << bootIdentifier.Data3 << '-'
        << std::setw(2) << static_cast<unsigned int>(bootIdentifier.Data4[0])
        << std::setw(2) << static_cast<unsigned int>(bootIdentifier.Data4[1]) << '-';
    for (size_t index = 2; index < 8; ++index) {
        bootIdText << std::setw(2) << static_cast<unsigned int>(bootIdentifier.Data4[index]);
    }

    FILETIME bootFileTime{};
    bootFileTime.dwLowDateTime = static_cast<DWORD>(bootTimeFileTicks & 0xFFFFFFFFULL);
    bootFileTime.dwHighDateTime = static_cast<DWORD>(bootTimeFileTicks >> 32);
    SYSTEMTIME bootSystemTime{};
    if (!FileTimeToSystemTime(&bootFileTime, &bootSystemTime)) {
        error = ERROR_INVALID_DATA;
        return false;
    }
    const std::uint64_t subMillisecondTicks = (bootTimeFileTicks % 10000000ULL) % 10000ULL;
    std::ostringstream bootTimeText;
    bootTimeText << std::setfill('0') << std::setw(4) << bootSystemTime.wYear << '-'
        << std::setw(2) << bootSystemTime.wMonth << '-' << std::setw(2) << bootSystemTime.wDay << 'T'
        << std::setw(2) << bootSystemTime.wHour << ':' << std::setw(2) << bootSystemTime.wMinute << ':'
        << std::setw(2) << bootSystemTime.wSecond << '.' << std::setw(3) << bootSystemTime.wMilliseconds;
    if (subMillisecondTicks != 0) bootTimeText << std::setw(4) << subMillisecondTicks;
    bootTimeText << 'Z';

    HANDLE rawToken = nullptr;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &rawToken)) {
        error = GetLastError();
        return false;
    }
    UniqueHandle token(rawToken);
    DWORD needed = 0;
    GetTokenInformation(token.value, TokenUser, nullptr, 0, &needed);
    if (needed == 0 || needed > 64 * 1024) { error = ERROR_INVALID_DATA; return false; }
    std::vector<BYTE> userBuffer(needed);
    if (!GetTokenInformation(token.value, TokenUser, userBuffer.data(), needed, &needed)) {
        error = GetLastError();
        return false;
    }
    const auto* tokenUser = reinterpret_cast<const TOKEN_USER*>(userBuffer.data());
    if (!IsValidSid(tokenUser->User.Sid)) { error = ERROR_INVALID_DATA; return false; }
    LPWSTR sidRaw = nullptr;
    if (!ConvertSidToStringSidW(tokenUser->User.Sid, &sidRaw)) {
        error = GetLastError();
        return false;
    }
    std::string userSid;
    for (const wchar_t ch : std::wstring(sidRaw)) {
        if (ch > 0x7F) { LocalFree(sidRaw); error = ERROR_INVALID_DATA; return false; }
        char value = static_cast<char>(ch);
        if (value >= 'a' && value <= 'z') value = static_cast<char>(value - 'a' + 'A');
        userSid.push_back(value);
    }
    LocalFree(sidRaw);

    TOKEN_STATISTICS statistics{};
    if (!GetTokenInformation(token.value, TokenStatistics, &statistics, sizeof(statistics), &needed) ||
        (statistics.AuthenticationId.LowPart == 0 && statistics.AuthenticationId.HighPart == 0)) {
        error = GetLastError();
        if (error == ERROR_SUCCESS) error = ERROR_INVALID_DATA;
        return false;
    }
    DWORD sessionId = 0;
    if (!ProcessIdToSessionId(GetCurrentProcessId(), &sessionId)) {
        error = GetLastError();
        return false;
    }
    std::ostringstream logonIdText;
    logonIdText << std::hex << std::nouppercase << std::setfill('0')
        << std::setw(8) << static_cast<std::uint32_t>(statistics.AuthenticationId.HighPart)
        << std::setw(8) << statistics.AuthenticationId.LowPart;

    const std::string canonical = "{\"bootId\":\"" + bootIdText.str() +
        "\",\"bootTime\":\"" + bootTimeText.str() + "\",\"userSid\":\"" + userSid +
        "\",\"sessionId\":" + std::to_string(sessionId) +
        ",\"logonId\":\"" + logonIdText.str() + "\"}";
    if (!Sha256Text(canonical, fingerprint)) { error = ERROR_GEN_FAILURE; return false; }
    error = ERROR_SUCCESS;
    return true;
}

bool ReadPermissionState(const Request& request, const std::wstring& statePath, DWORD& error) {
    UniqueHandle file;
    file.reset(CreateFileW(statePath.c_str(), GENERIC_READ | FILE_READ_ATTRIBUTES,
                           FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                           FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    if (!file.valid()) {
        error = GetLastError();
        return false;
    }
    FILE_ATTRIBUTE_TAG_INFO attributes{};
    LARGE_INTEGER size{};
    if (!GetFileInformationByHandleEx(file.get(), FileAttributeTagInfo,
                                      &attributes, sizeof(attributes)) ||
        !GetFileSizeEx(file.get(), &size)) {
        error = GetLastError();
        return false;
    }
    if ((attributes.FileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)) != 0 ||
        size.QuadPart < 2 || size.QuadPart > 64 * 1024) {
        error = ERROR_INVALID_DATA;
        return false;
    }
    std::string json(static_cast<size_t>(size.QuadPart), '\0');
    DWORD received = 0;
    if (!ReadFile(file.get(), json.data(), static_cast<DWORD>(json.size()), &received, nullptr) ||
        received != json.size()) {
        error = GetLastError();
        if (error == ERROR_SUCCESS) error = ERROR_HANDLE_EOF;
        return false;
    }

    ParsedPermissionState state;
    std::string expectedWorkspaceId;
    std::string expectedIdentityFingerprint;
    std::string expectedGrantId;
    std::string currentIdentityFingerprint;
    if (!CurrentWindowsSessionFingerprint(currentIdentityFingerprint, error)) return false;
    if (!ToAscii(request.fullAccessWorkspaceId, expectedWorkspaceId) ||
        !ToAscii(request.sessionGrantFingerprint, expectedIdentityFingerprint) ||
        !ToAscii(request.sessionGrantId, expectedGrantId) ||
        !ParsePermissionState(json, state) || state.version != "2" ||
        state.workspaceId != expectedWorkspaceId || state.baselineMode != "level1" ||
        state.sessionGrant.identityFingerprint != expectedIdentityFingerprint ||
        expectedIdentityFingerprint != currentIdentityFingerprint ||
        state.sessionGrant.grantId != expectedGrantId) {
        error = ERROR_ACCESS_DENIED;
        return false;
    }
    return true;
}

enum class GitPlanAuthorizationKind { legacy, repositoryApproval, fullAccess };

struct ParsedGitPlanAuthorization {
    GitPlanAuthorizationKind kind = GitPlanAuthorizationKind::legacy;
    std::string permissionMode;
    std::string sessionGrantFingerprint;
    std::string sessionGrantId;
};

bool ParseGitPlanAuthorizationValue(const std::string& json, size_t& cursor,
                                    ParsedGitPlanAuthorization& authorization) {
    SkipJsonWhitespace(json, cursor);
    if (cursor >= json.size() || json[cursor++] != '{') return false;
    bool hasSource = false;
    bool hasPermissionMode = false;
    bool hasFingerprint = false;
    bool hasGrantId = false;
    size_t fields = 0;
    for (;;) {
        std::string key;
        if (!ReadJsonObjectMemberPrefix(json, cursor, key)) return false;
        SkipJsonWhitespace(json, cursor);
        if (key == "source") {
            if (hasSource || !ParseJsonString(json, cursor, authorization.permissionMode)) return false;
            hasSource = true;
            if (authorization.permissionMode == "repository_approval") {
                authorization.kind = GitPlanAuthorizationKind::repositoryApproval;
            } else if (authorization.permissionMode == "full_access") {
                authorization.kind = GitPlanAuthorizationKind::fullAccess;
            } else {
                return false;
            }
        } else if (key == "permissionMode") {
            if (hasPermissionMode || !ParseJsonString(json, cursor, authorization.permissionMode)) return false;
            hasPermissionMode = true;
        } else if (key == "sessionGrantFingerprint") {
            if (hasFingerprint || !ParseJsonString(json, cursor, authorization.sessionGrantFingerprint)) return false;
            hasFingerprint = true;
        } else if (key == "sessionGrantId") {
            if (hasGrantId || !ParseJsonString(json, cursor, authorization.sessionGrantId)) return false;
            hasGrantId = true;
        } else {
            return false;
        }
        ++fields;
        SkipJsonWhitespace(json, cursor);
        if (cursor >= json.size()) return false;
        if (json[cursor] == '}') { ++cursor; break; }
        if (json[cursor++] != ',') return false;
        SkipJsonWhitespace(json, cursor);
    }
    if (!hasSource) return false;
    if (authorization.kind == GitPlanAuthorizationKind::repositoryApproval) {
        return fields == 1 && !hasPermissionMode && !hasFingerprint && !hasGrantId;
    }
    return authorization.kind == GitPlanAuthorizationKind::fullAccess && fields == 4 &&
        hasPermissionMode && hasFingerprint && hasGrantId &&
        authorization.permissionMode == "level2" &&
        IsHex(std::wstring(authorization.sessionGrantFingerprint.begin(),
                           authorization.sessionGrantFingerprint.end()), 64) &&
        IsHex(std::wstring(authorization.sessionGrantId.begin(),
                           authorization.sessionGrantId.end()), 64);
}

bool ParseGitPlanAuthorization(const std::string& json, ParsedGitPlanAuthorization& authorization) {
    size_t cursor = 0;
    SkipJsonWhitespace(json, cursor);
    if (cursor >= json.size() || json[cursor++] != '{') return false;
    bool seenAuthorization = false;
    for (;;) {
        std::string key;
        if (!ReadJsonObjectMemberPrefix(json, cursor, key)) return false;
        SkipJsonWhitespace(json, cursor);
        if (key == "authorization") {
            if (seenAuthorization) return false;
            seenAuthorization = true;
            if (!ParseGitPlanAuthorizationValue(json, cursor, authorization)) return false;
        } else if (!SkipJsonValue(json, cursor, 1)) {
            return false;
        }
        SkipJsonWhitespace(json, cursor);
        if (cursor >= json.size()) return false;
        if (json[cursor] == '}') { ++cursor; break; }
        if (json[cursor++] != ',') return false;
        SkipJsonWhitespace(json, cursor);
    }
    SkipJsonWhitespace(json, cursor);
    return cursor == json.size();
}

bool ReadGitPlanAuthorization(const Request& request, ParsedGitPlanAuthorization& authorization,
                              DWORD& error) {
    UniqueHandle file;
    file.reset(CreateFileW(request.approvalManifest.c_str(), GENERIC_READ | FILE_READ_ATTRIBUTES,
                           FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                           FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    if (!file.valid()) { error = GetLastError(); return false; }
    FILE_ATTRIBUTE_TAG_INFO attributes{};
    LARGE_INTEGER size{};
    if (!GetFileInformationByHandleEx(file.get(), FileAttributeTagInfo,
                                      &attributes, sizeof(attributes)) ||
        !GetFileSizeEx(file.get(), &size)) {
        error = GetLastError();
        return false;
    }
    if ((attributes.FileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)) != 0 ||
        size.QuadPart < 2 || size.QuadPart > 1024 * 1024) {
        error = ERROR_INVALID_DATA;
        return false;
    }
    std::wstring actualHash;
    if (!Sha256(file.get(), actualHash, error) || !SameOrdinal(actualHash, request.approvalManifestHash)) {
        if (error == ERROR_SUCCESS) error = ERROR_ACCESS_DENIED;
        return false;
    }
    LARGE_INTEGER beginning{};
    if (!SetFilePointerEx(file.get(), beginning, nullptr, FILE_BEGIN)) {
        error = GetLastError();
        return false;
    }
    std::string json(static_cast<size_t>(size.QuadPart), '\\0');
    DWORD received = 0;
    if (!ReadFile(file.get(), json.data(), static_cast<DWORD>(json.size()), &received, nullptr) ||
        received != json.size()) {
        error = GetLastError();
        if (error == ERROR_SUCCESS) error = ERROR_HANDLE_EOF;
        return false;
    }
    if (!ParseGitPlanAuthorization(json, authorization)) {
        error = ERROR_INVALID_DATA;
        return false;
    }
    return true;
}

bool AcquireFullAccessLaunchPermit(const Request& request, PermissionLaunchPermit& permit,
                                   DWORD& error) {
    std::wstring statePath;
    std::wstring lockPath;
    if (!ExpectedPermissionStatePaths(request, statePath, lockPath, error)) return false;

    // Permission writers use the same exclusive lock. Wait briefly for an
    // in-progress write, then read the committed state while holding the lock.
    const auto lockDeadline = std::chrono::steady_clock::now() + std::chrono::seconds(1);
    for (;;) {
        if (permit.acquire(lockPath, error)) break;
        if (error != ERROR_FILE_EXISTS && error != ERROR_ALREADY_EXISTS) return false;
        if (std::chrono::steady_clock::now() >= lockDeadline) {
            error = ERROR_BUSY;
            return false;
        }
        Sleep(5);
    }
    if (!ReadPermissionState(request, statePath, error)) {
        permit.reset();
        return false;
    }
    return true;
}

// The Bridge binds the Git plan and grant to the job; the helper independently
// validates the revocable grant while retaining the existing material locks.
bool AcquireLaunchPermit(const Request& request, UniqueHandle& permit,
                         PermissionLaunchPermit& fullAccessPermit, DWORD& error) {
    if (request.recipe == 3) return AcquireFullAccessLaunchPermit(request, fullAccessPermit, error);
    if (request.recipe != 2) {
        if (request.hasFullAccessGrant) { error = ERROR_INVALID_DATA; return false; }
        return true;
    }
    const std::wstring leaf = request.approvalManifest.substr(
        request.approvalManifest.find_last_of(L'\\') + 1);
    const bool level3Manifest = HasRequestIdSuffix(leaf, L".manifest.json");
    if (!level3Manifest) {
        ParsedGitPlanAuthorization authorization;
        if (!ReadGitPlanAuthorization(request, authorization, error)) return false;
        if (request.hasFullAccessGrant) {
            std::string expectedFingerprint;
            std::string expectedGrantId;
            if (authorization.kind != GitPlanAuthorizationKind::fullAccess ||
                authorization.permissionMode != "level2" ||
                !ToAscii(request.sessionGrantFingerprint, expectedFingerprint) ||
                !ToAscii(request.sessionGrantId, expectedGrantId) ||
                authorization.sessionGrantFingerprint != expectedFingerprint ||
                authorization.sessionGrantId != expectedGrantId) {
                error = ERROR_ACCESS_DENIED;
                return false;
            }
            return AcquireFullAccessLaunchPermit(request, fullAccessPermit, error);
        }
        if (authorization.kind == GitPlanAuthorizationKind::fullAccess) {
            error = ERROR_ACCESS_DENIED;
            return false;
        }
        return true;
    }
    if (request.hasFullAccessGrant) { error = ERROR_INVALID_DATA; return false; }
    std::string expected;
    if (!ToAscii(request.approvalManifestHash, expected)) { error = ERROR_INVALID_DATA; return false; }
    return OpenMatchingMarkerFile(request.approvalManifest + L".permit", expected,
                                  GENERIC_READ, permit, error);
}

// Test-only deny/delay barrier; no MCP input or child environment can set it.
// Failure to release within three seconds never resumes the child.
bool TestWaitBeforeResume(const wchar_t* phase, DWORD childPid, DWORD& error) {
    std::wstring release, selected;
    DWORD environmentError = ERROR_SUCCESS;
    if (!ReadEnvironmentValue(L"C2C_EXECUTION_HELPER_TEST_RELEASE", release, environmentError)) return true;
    if (!ReadEnvironmentValue(L"C2C_EXECUTION_HELPER_TEST_PHASE", selected, environmentError) || selected != phase) return true;
    std::string phaseText;
    ToAscii(selected, phaseText);
    const std::string evidence = "C2C_EXECUTION_HELPER_SUSPENDED:" + std::to_string(childPid) + ":" + phaseText + "\n";
    DWORD written = 0;
    WriteFile(GetStdHandle(STD_ERROR_HANDLE), evidence.data(), static_cast<DWORD>(evidence.size()), &written, nullptr);
    const auto end = std::chrono::steady_clock::now() + std::chrono::seconds(3);
    while (std::chrono::steady_clock::now() < end) {
        const DWORD attributes = GetFileAttributesW(release.c_str());
        if (attributes != INVALID_FILE_ATTRIBUTES && (attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) == 0) return true;
        Sleep(5);
    }
    error = ERROR_TIMEOUT;
    return false;
}

bool MatchesTempRootMarker(const std::wstring& path, const std::string& workspaceId,
                           const std::string& identity, DWORD& error) {
    const std::string current = "C2C-EXECUTION-TEMP-ROOT-V2\n" + workspaceId + "\n" + identity + "\n";
    if (MatchesMarkerFile(path, current, error)) return true;
    if (error != ERROR_INVALID_DATA) return false;
    // Existing V1 roots are accepted for upgrade compatibility. The root's
    // current file identity and each job's persisted nonce/sidecar still bind
    // every cleanup operation; V1 marker text alone grants no job ownership.
    const std::string legacy = "C2C-EXECUTION-TEMP-ROOT-V1\n" + workspaceId + "\n";
    return MatchesMarkerFile(path, legacy, error);
}

bool ValidateTempOwnershipMarkers(const Request& request, DWORD& error) {
    std::string workspaceId;
    std::string jobId;
    std::string nonce;
    std::string rootIdentity;
    std::string directoryIdentity;
    std::string createdAt;
    if (!ToAscii(request.tempWorkspaceId, workspaceId) || !ToAscii(request.tempJobId, jobId) ||
        !ToAscii(request.tempNonce, nonce) || !ToAscii(request.tempRootFileIdentity, rootIdentity) ||
        !ToAscii(request.jobTempFileIdentity, directoryIdentity) ||
        !ToAscii(request.tempCreatedAtMs, createdAt)) {
        error = ERROR_INVALID_DATA;
        return false;
    }
    const std::string jobMarker = "C2C-EXECUTION-TEMP-JOB-V2\n" + workspaceId + "\n" + jobId + "\n" +
        nonce + "\n" + rootIdentity + "\n" + directoryIdentity + "\n" + createdAt + "\n";
    const std::string authorityMarker = "C2C-EXECUTION-TEMP-AUTHORITY-V1\n" + workspaceId + "\n" + jobId + "\n" +
        nonce + "\n" + rootIdentity + "\n" + directoryIdentity + "\n" + createdAt + "\n";
    const size_t separator = request.tempRootPath.find_last_of(L'\\');
    if (separator == std::wstring::npos) {
        error = ERROR_INVALID_NAME;
        return false;
    }
    const std::wstring authorityPath = request.tempRootPath.substr(0, separator) +
        L"\\.c2c-execution-temp-job-" + request.tempJobId;
    return MatchesTempRootMarker(request.tempRootPath + L"\\.c2c-execution-temp-owner",
                                 workspaceId, rootIdentity, error) &&
           MatchesMarkerFile(request.jobTempDir + L"\\.c2c-job-owner", jobMarker, error) &&
           MatchesMarkerFile(authorityPath, authorityMarker, error);
}

bool MarkHandleForDeletion(HANDLE handle, DWORD& error) {
    FILE_DISPOSITION_INFO_EX disposition{};
    disposition.Flags = FILE_DISPOSITION_FLAG_DELETE |
                       FILE_DISPOSITION_FLAG_POSIX_SEMANTICS |
                       FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE;
    if (SetFileInformationByHandle(handle, FileDispositionInfoEx,
                                   &disposition, sizeof(disposition))) return true;
    const DWORD extendedError = GetLastError();
    if (extendedError != ERROR_INVALID_PARAMETER && extendedError != ERROR_NOT_SUPPORTED) {
        error = extendedError;
        return false;
    }
    FILE_DISPOSITION_INFO basic{};
    basic.DeleteFile = TRUE;
    if (!SetFileInformationByHandle(handle, FileDispositionInfo, &basic, sizeof(basic))) {
        error = GetLastError();
        return false;
    }
    return true;
}

bool DeleteOwnedDirectoryContents(HANDLE directory, const std::wstring& directoryPath,
                                  DWORD& error) {
    BY_HANDLE_FILE_INFORMATION parentInfo{};
    if (!GetFileInformationByHandle(directory, &parentInfo)) {
        error = GetLastError();
        return false;
    }
    std::vector<BYTE> buffer(64 * 1024);
    for (;;) {
        if (!GetFileInformationByHandleEx(directory, FileIdBothDirectoryRestartInfo,
                                          buffer.data(), static_cast<DWORD>(buffer.size()))) {
            const DWORD queryError = GetLastError();
            if (queryError == ERROR_NO_MORE_FILES) return true;
            error = queryError;
            return false;
        }
        FILE_ID_BOTH_DIR_INFO* entry = reinterpret_cast<FILE_ID_BOTH_DIR_INFO*>(buffer.data());
        std::wstring childName;
        std::uint64_t enumeratedFileId = 0;
        while (entry != nullptr) {
            childName.assign(entry->FileName, entry->FileNameLength / sizeof(WCHAR));
            if (childName != L"." && childName != L"..") {
                enumeratedFileId = static_cast<std::uint64_t>(entry->FileId.QuadPart);
                break;
            }
            if (entry->NextEntryOffset == 0) entry = nullptr;
            else entry = reinterpret_cast<FILE_ID_BOTH_DIR_INFO*>(
                reinterpret_cast<BYTE*>(entry) + entry->NextEntryOffset);
        }
        if (entry == nullptr) return true;

        const std::wstring childPath = directoryPath + L"\\" + childName;
        UniqueHandle child(CreateFileW(childPath.c_str(), GENERIC_READ | DELETE,
                                       FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                                       FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                                       nullptr));
        if (!child.valid()) {
            error = GetLastError();
            return false;
        }
        BY_HANDLE_FILE_INFORMATION childInfo{};
        if (!GetFileInformationByHandle(child.get(), &childInfo)) {
            error = GetLastError();
            return false;
        }
        const std::uint64_t openedFileId =
            (static_cast<std::uint64_t>(childInfo.nFileIndexHigh) << 32) | childInfo.nFileIndexLow;
        if (childInfo.dwVolumeSerialNumber != parentInfo.dwVolumeSerialNumber ||
            enumeratedFileId == 0 || openedFileId != enumeratedFileId) {
            error = ERROR_FILE_INVALID;
            return false;
        }
        FILE_ATTRIBUTE_TAG_INFO attributes{};
        if (!GetFileInformationByHandleEx(child.get(), FileAttributeTagInfo,
                                          &attributes, sizeof(attributes))) {
            error = GetLastError();
            return false;
        }
        const bool reparse = (attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
        const bool isDirectory = (attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
        if (!reparse && isDirectory &&
            !DeleteOwnedDirectoryContents(child.get(), childPath, error)) return false;
        if (!MarkHandleForDeletion(child.get(), error)) return false;
    }
}

bool CleanupOwnedExecutionTemp(const TempCleanupRequest& request, DWORD& error) {
    if (!IsSafeLabel(request.workspaceId, 128) || request.jobId.size() < 24 ||
        request.jobId.size() > 64 || !IsSafeLabel(request.jobId, 64) ||
        !IsHex(request.nonce, 64) || !IsIdentity(request.rootFileIdentity) ||
        !IsIdentity(request.directoryFileIdentity) || request.createdAtMs.empty() ||
        request.createdAtMs.size() > 16 ||
        !std::all_of(request.createdAtMs.begin(), request.createdAtMs.end(), [](wchar_t ch) {
            return ch >= L'0' && ch <= L'9';
        })) {
        error = ERROR_INVALID_DATA;
        return false;
    }
    std::wstring canonicalRoot;
    if (!ValidateCanonicalPath(request.rootPath, true, canonicalRoot, error) ||
        !IsBasename(canonicalRoot, L"execution-temp")) {
        if (error == ERROR_SUCCESS) error = ERROR_INVALID_NAME;
        return false;
    }
    std::wstring expectedRoot;
    if (!ExpectedExecutionTempRoot(request.workspaceId, expectedRoot, error) ||
        !SameOrdinal(canonicalRoot, expectedRoot)) {
        if (error == ERROR_SUCCESS) error = ERROR_ACCESS_DENIED;
        return false;
    }

    std::vector<UniqueHandle> rootLocks;
    if (!LockDirectoryPath(canonicalRoot, &request.rootFileIdentity, rootLocks, error, true)) return false;
    std::string workspaceId;
    std::string jobId;
    std::string nonce;
    std::string rootIdentity;
    std::string directoryIdentity;
    std::string createdAt;
    if (!ToAscii(request.workspaceId, workspaceId) || !ToAscii(request.jobId, jobId) ||
        !ToAscii(request.nonce, nonce) || !ToAscii(request.rootFileIdentity, rootIdentity) ||
        !ToAscii(request.directoryFileIdentity, directoryIdentity) || !ToAscii(request.createdAtMs, createdAt)) {
        error = ERROR_INVALID_DATA;
        return false;
    }
    if (!MatchesTempRootMarker(canonicalRoot + L"\\.c2c-execution-temp-owner",
                               workspaceId, rootIdentity, error)) return false;

    const std::wstring storeDirectory = ParentDirectory(canonicalRoot);
    const std::wstring authorityPath = storeDirectory + L"\\.c2c-execution-temp-job-" + request.jobId;
    const std::string expectedAuthority = "C2C-EXECUTION-TEMP-AUTHORITY-V1\n" + workspaceId + "\n" + jobId + "\n" +
        nonce + "\n" + rootIdentity + "\n" + directoryIdentity + "\n" + createdAt + "\n";
    UniqueHandle authority;
    if (!OpenMatchingMarkerFile(authorityPath, expectedAuthority, GENERIC_READ | DELETE, authority, error)) return false;

    const std::wstring targetPath = canonicalRoot + L"\\tmp-" + request.jobId;
    UniqueHandle target(CreateFileW(targetPath.c_str(), FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY | DELETE,
                                    FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                                    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                                    nullptr));
    if (!target.valid()) {
        const DWORD openError = GetLastError();
        error = openError;
        return false;
    }
    if (!DirectoryAttributes(target.get(), error)) return false;
    std::wstring actualIdentity;
    if (!FileIdentity(target.get(), actualIdentity, error) ||
        !SameOrdinal(actualIdentity, request.directoryFileIdentity)) {
        if (error == ERROR_SUCCESS) error = ERROR_FILE_INVALID;
        return false;
    }
    FILE_BASIC_INFO targetBasicInfo{};
    std::uint64_t expectedCreatedAtMs = 0;
    if (!GetFileInformationByHandleEx(target.get(), FileBasicInfo,
                                      &targetBasicInfo, sizeof(targetBasicInfo)) ||
        !ParseUnsignedDecimal(request.createdAtMs, expectedCreatedAtMs)) {
        error = GetLastError();
        if (error == ERROR_SUCCESS) error = ERROR_INVALID_DATA;
        return false;
    }
    constexpr std::uint64_t kWindowsEpochOffsetMs = 11644473600000ULL;
    const std::uint64_t creationTicks = static_cast<std::uint64_t>(targetBasicInfo.CreationTime.QuadPart);
    const std::uint64_t actualCreatedAtMs = creationTicks / 10000ULL;
    if (actualCreatedAtMs < kWindowsEpochOffsetMs ||
        actualCreatedAtMs - kWindowsEpochOffsetMs != expectedCreatedAtMs) {
        error = ERROR_FILE_INVALID;
        return false;
    }
    const std::string expectedJobMarker = "C2C-EXECUTION-TEMP-JOB-V2\n" + workspaceId + "\n" + jobId + "\n" +
        nonce + "\n" + rootIdentity + "\n" + directoryIdentity + "\n" + createdAt + "\n";
    if (!MatchesMarkerFile(targetPath + L"\\.c2c-job-owner", expectedJobMarker, error)) return false;
    if (!DeleteOwnedDirectoryContents(target.get(), targetPath, error)) return false;
    if (!MarkHandleForDeletion(target.get(), error)) return false;
    if (!MarkHandleForDeletion(authority.get(), error)) return false;
    return true;
}

int RunTempCleanup(HANDLE input) {
    DWORD error = ERROR_SUCCESS;
    TempCleanupRequest request;
    if (!ReadTempCleanupRequest(input, request, error) || !CleanupOwnedExecutionTemp(request, error)) {
        if (error == ERROR_SUCCESS) error = ERROR_GEN_FAILURE;
        const std::string diagnostic = "EXECUTION_TEMP_CLEANUP_WIN32_ERROR:" + std::to_string(error) + "\n";
        DWORD written = 0;
        HANDLE output = GetStdHandle(STD_ERROR_HANDLE);
        if (output != nullptr && output != INVALID_HANDLE_VALUE) {
            WriteFile(output, diagnostic.data(), static_cast<DWORD>(diagnostic.size()), &written, nullptr);
        }
        return 1;
    }
    return 0;
}

void WriteHelperFailureDiagnostic(const char* stage, DWORD error) {
    if (stage == nullptr || error == ERROR_SUCCESS) return;
    const std::string diagnostic = "EXECUTION_HELPER_FAILURE:" + std::string(stage) + ":" +
                                   std::to_string(error) + "\n";
    DWORD written = 0;
    HANDLE output = GetStdHandle(STD_ERROR_HANDLE);
    if (output != nullptr && output != INVALID_HANDLE_VALUE) {
        WriteFile(output, diagnostic.data(), static_cast<DWORD>(diagnostic.size()), &written, nullptr);
    }
}

bool LockExecutionMaterials(const Request& request, std::vector<UniqueHandle>& locks,
                            DWORD& error) {
    if (request.recipe == 3) {
        const size_t separator = request.genericExecutable.find_last_of(L'\\');
        if (separator == std::wstring::npos) {
            error = ERROR_INVALID_NAME;
            return false;
        }
        const std::wstring executableDirectory = separator == 2
            ? request.genericExecutable.substr(0, 3)
            : request.genericExecutable.substr(0, separator);
        return LockDirectoryPath(request.genericCwd, &request.genericCwdFileIdentity, locks, error) &&
               LockDirectoryPath(request.tempRootPath, &request.tempRootFileIdentity, locks, error) &&
               LockDirectoryPath(request.jobTempDir, &request.jobTempFileIdentity, locks, error) &&
               ValidateTempOwnershipMarkers(request, error) &&
               LockDirectoryPath(executableDirectory, nullptr, locks, error) &&
               OpenFileLock(request.genericExecutable, &request.genericExecutableFileIdentity,
                            &request.genericExecutableHash, locks, error);
    }
    if (!LockDirectoryPath(request.cwd, &request.repositoryFileIdentity, locks, error) ||
        !LockDirectoryPath(request.gitDirectory, &request.gitDirectoryFileIdentity, locks, error) ||
        !LockDirectoryPath(request.commonGitDirectory, &request.commonGitDirectoryFileIdentity, locks, error) ||
        !LockDirectoryPath(request.tempRootPath, &request.tempRootFileIdentity, locks, error) ||
        !LockDirectoryPath(request.jobTempDir, &request.jobTempFileIdentity, locks, error)) {
        return false;
    }
    if (request.recipe == 2 &&
        !LockDirectoryPath(request.genericCwd, &request.genericCwdFileIdentity, locks, error)) {
        return false;
    }
    if (!ValidateTempOwnershipMarkers(request, error)) return false;
    const std::wstring gitEntryPath = request.cwd + L"\\.git";
    if (request.gitEntryType == 2) {
        if (!LockDirectoryPath(gitEntryPath, &request.gitEntryFileIdentity, locks, error)) return false;
    } else if (!OpenFileLock(gitEntryPath, &request.gitEntryFileIdentity,
                             &request.gitEntryHash, locks, error)) {
        return false;
    }

    if (request.recipe == 1) {
        const std::wstring manifestPath = request.cwd + L"\\package.json";
        if (!OpenFileLock(manifestPath, nullptr, &request.packageJsonHash, locks, error)) return false;
    } else if (!OpenFileLock(request.approvalManifest, &request.approvalManifestFileIdentity,
                             &request.approvalManifestHash, locks, error)) {
        return false;
    }

    const auto parentDirectory = [](const std::wstring& file) {
        const size_t separator = file.find_last_of(L'\\');
        return separator == 2 ? file.substr(0, 3) : file.substr(0, separator);
    };
    if (!LockDirectoryPath(parentDirectory(request.nodeExecutable), nullptr, locks, error) ||
        !LockDirectoryPath(parentDirectory(request.managerCli), nullptr, locks, error) ||
        !LockDirectoryPath(parentDirectory(request.managerLibCli), nullptr, locks, error) ||
        !LockDirectoryPath(parentDirectory(request.managerValidateEngines), nullptr, locks, error) ||
        !LockDirectoryPath(parentDirectory(request.managerMainEntry), nullptr, locks, error) ||
        !LockDirectoryPath(parentDirectory(request.managerPackageJson), nullptr, locks, error) ||
        !LockDirectoryPath(parentDirectory(request.managerExitHandler), nullptr, locks, error) ||
        !LockDirectoryPath(parentDirectory(request.managerCore), nullptr, locks, error) ||
        !OpenFileLock(request.nodeExecutable, &request.nodeFileIdentity,
                      &request.nodeHash, locks, error) ||
        !OpenFileLock(request.managerCli, &request.managerFileIdentity,
                      &request.managerHash, locks, error) ||
        !OpenFileLock(request.managerLibCli, &request.managerLibCliFileIdentity,
                      &request.managerLibCliHash, locks, error) ||
        !OpenFileLock(request.managerValidateEngines, &request.managerValidateEnginesFileIdentity,
                      &request.managerValidateEnginesHash, locks, error) ||
        !OpenFileLock(request.managerMainEntry, &request.managerMainEntryFileIdentity,
                      &request.managerMainEntryHash, locks, error) ||
        !OpenFileLock(request.managerPackageJson, &request.managerPackageJsonFileIdentity,
                      &request.managerPackageJsonHash, locks, error) ||
        !OpenFileLock(request.managerExitHandler, &request.managerExitHandlerFileIdentity,
                      &request.managerExitHandlerHash, locks, error) ||
        !OpenFileLock(request.managerCore, &request.managerCoreFileIdentity,
                      &request.managerCoreHash, locks, error)) {
        return false;
    }
    if (request.recipe == 2) {
        if (!OpenFileLock(request.genericExecutable, &request.genericExecutableFileIdentity,
                          &request.genericExecutableHash, locks, error)) return false;
        for (const auto& material : request.genericMaterials) {
            if (!OpenFileLock(material.path, &material.fileIdentity,
                              &material.hash, locks, error)) return false;
        }
    }
    return true;
}

bool JoinPath(const std::wstring& base, const std::wstring& leaf,
              std::wstring& joined, DWORD& error) {
    if (base.empty() || leaf.empty() || leaf.find(L'\\') != std::wstring::npos ||
        leaf.find(L'/') != std::wstring::npos || leaf == L"." || leaf == L"..") {
        error = ERROR_INVALID_NAME;
        return false;
    }
    joined = base;
    if (joined.back() != L'\\') {
        joined.push_back(L'\\');
    }
    joined += leaf;
    if (joined.size() > 32760) {
        error = ERROR_FILENAME_EXCED_RANGE;
        return false;
    }
    return true;
}

bool CreatePrivateJobTemp(const std::wstring& parent, std::wstring& privateDir,
                          DWORD& error) {
    const ULONGLONG seed = GetTickCount64();
    for (DWORD attempt = 0; attempt < 32; ++attempt) {
        const std::wstring leaf = L".c2c-job-" + std::to_wstring(seed) + L"-" +
                                  std::to_wstring(attempt);
        std::wstring candidate;
        if (!JoinPath(parent, leaf, candidate, error)) {
            return false;
        }
        if (CreateDirectoryW(candidate.c_str(), nullptr)) {
            if (!ValidateCanonicalPath(candidate, true, privateDir, error)) {
                return false;
            }
            return true;
        }
        error = GetLastError();
        if (error != ERROR_ALREADY_EXISTS && error != ERROR_FILE_EXISTS) {
            return false;
        }
    }
    error = ERROR_ALREADY_EXISTS;
    return false;
}

bool CreateEmptyPrivateFile(const std::wstring& path, DWORD& error) {
    UniqueHandle file(CreateFileW(path.c_str(), GENERIC_READ | GENERIC_WRITE,
                                  FILE_SHARE_READ, nullptr, CREATE_NEW,
                                  FILE_ATTRIBUTE_NORMAL, nullptr));
    if (!file.valid()) {
        error = GetLastError();
        return false;
    }
    FILE_ATTRIBUTE_TAG_INFO info{};
    if (!GetFileInformationByHandleEx(file.get(), FileAttributeTagInfo,
                                      &info, sizeof(info))) {
        error = GetLastError();
        return false;
    }
    if ((info.FileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)) != 0) {
        error = ERROR_REPARSE_TAG_INVALID;
        return false;
    }
    return true;
}

bool GetWindowsDirectoryCanonical(std::wstring& windowsDir, DWORD& error) {
    std::vector<wchar_t> buffer(32768, L'\0');
    const UINT length = GetWindowsDirectoryW(buffer.data(), static_cast<UINT>(buffer.size()));
    if (length == 0 || length >= buffer.size()) {
        error = length == 0 ? GetLastError() : ERROR_FILENAME_EXCED_RANGE;
        return false;
    }
    std::wstring value(buffer.data(), length);
    while (value.size() > 3 && value.back() == L'\\') {
        value.pop_back();
    }
    return ValidateCanonicalPath(value, true, windowsDir, error);
}

struct ChildEnvironment {
    std::wstring systemRoot;
    std::wstring system32;
    std::wstring comSpec;
    std::wstring path;
    std::wstring privateTemp;
    std::wstring userConfig;
    std::wstring globalConfig;
    std::wstring npmCache;
    std::wstring pnpmStore;
    std::wstring pnpmCache;
    std::wstring gitConfig;
    std::wstring gitHooksDir;
    std::vector<wchar_t> block;
};

bool BuildEnvironment(const Request& request, ChildEnvironment& environment, DWORD& error) {
    std::wstring windowsDir;
    if (!GetWindowsDirectoryCanonical(windowsDir, error)) {
        return false;
    }
    std::wstring system32Path;
    std::wstring commandInterpreter;
    if (!JoinPath(windowsDir, L"System32", system32Path, error) ||
        !ValidateCanonicalPath(system32Path, true, environment.system32, error) ||
        !JoinPath(environment.system32, L"cmd.exe", commandInterpreter, error) ||
        !ValidateCanonicalPath(commandInterpreter, false, environment.comSpec, error)) {
        return false;
    }

    std::wstring privateDir;
    if (!CreatePrivateJobTemp(request.jobTempDir, privateDir, error)) {
        return false;
    }
    environment.privateTemp = privateDir;

    if (request.recipe == 3) {
        LPWCH inherited = GetEnvironmentStringsW();
        if (inherited == nullptr) {
            error = GetLastError();
            return false;
        }
        std::vector<std::pair<std::wstring, std::wstring>> entries;
        for (const wchar_t* current = inherited; *current != L'\0'; current += std::wcslen(current) + 1) {
            const std::wstring assignment(current);
            const size_t separator = assignment.find(L'=', assignment.empty() || assignment[0] != L'=' ? 0 : 1);
            if (separator == std::wstring::npos || separator == 0) continue;
            const std::wstring name = assignment.substr(0, separator);
            if (SameOrdinal(name, L"TEMP") || SameOrdinal(name, L"TMP")) continue;
            entries.emplace_back(name, assignment.substr(separator + 1));
        }
        FreeEnvironmentStringsW(inherited);
        entries.emplace_back(L"TEMP", environment.privateTemp);
        entries.emplace_back(L"TMP", environment.privateTemp);
        std::sort(entries.begin(), entries.end(), [](const auto& left, const auto& right) {
            return CompareStringOrdinal(left.first.c_str(), -1,
                                        right.first.c_str(), -1, TRUE) == CSTR_LESS_THAN;
        });
        for (const auto& entry : entries) {
            const std::wstring assignment = entry.first + L"=" + entry.second;
            environment.block.insert(environment.block.end(), assignment.begin(), assignment.end());
            environment.block.push_back(L'\0');
        }
        environment.block.push_back(L'\0');
        return true;
    }

    if (!JoinPath(privateDir, L"user.npmrc", environment.userConfig, error) ||
        !JoinPath(privateDir, L"global.npmrc", environment.globalConfig, error) ||
        !JoinPath(privateDir, L"npm-cache", environment.npmCache, error) ||
        !JoinPath(privateDir, L"pnpm-store", environment.pnpmStore, error) ||
        !JoinPath(privateDir, L"pnpm-cache", environment.pnpmCache, error) ||
        !JoinPath(privateDir, L"gitconfig", environment.gitConfig, error) ||
        !JoinPath(privateDir, L"empty-git-hooks", environment.gitHooksDir, error)) {
        return false;
    }
    if (!CreateEmptyPrivateFile(environment.userConfig, error) ||
        !CreateEmptyPrivateFile(environment.globalConfig, error) ||
        !CreateEmptyPrivateFile(environment.gitConfig, error)) {
        return false;
    }
    if (!CreateDirectoryW(environment.gitHooksDir.c_str(), nullptr) ||
        !ValidateCanonicalPath(environment.gitHooksDir, true, environment.gitHooksDir, error)) {
        if (error == ERROR_SUCCESS) error = GetLastError();
        return false;
    }

    const size_t slash = request.nodeExecutable.find_last_of(L'\\');
    if (slash == std::wstring::npos) {
        error = ERROR_INVALID_NAME;
        return false;
    }
    const std::wstring nodeDirectory = slash == 2
                                           ? request.nodeExecutable.substr(0, 3)
                                           : request.nodeExecutable.substr(0, slash);
    environment.path = request.recipe == 2
        ? environment.system32
        : environment.system32 + L";" + nodeDirectory;
    environment.systemRoot = windowsDir;

    std::vector<std::pair<std::wstring, std::wstring>> entries = {
        {L"SystemRoot", environment.systemRoot},
        {L"WINDIR", environment.systemRoot},
        {L"ComSpec", environment.comSpec},
        {L"PATH", environment.path},
        {L"TEMP", environment.privateTemp},
        {L"TMP", environment.privateTemp},
        {L"USERPROFILE", environment.privateTemp},
        {L"HOME", environment.privateTemp},
        {L"APPDATA", environment.privateTemp},
        {L"LOCALAPPDATA", environment.privateTemp},
        {L"PATHEXT", L".COM;.EXE;.BAT;.CMD"},
        {L"GIT_CONFIG_COUNT", L"2"},
        {L"GIT_CONFIG_KEY_0", L"core.hooksPath"},
        {L"GIT_CONFIG_VALUE_0", environment.gitHooksDir},
        {L"GIT_CONFIG_KEY_1", L"credential.helper"},
        {L"GIT_CONFIG_VALUE_1", L""},
        {L"GIT_TERMINAL_PROMPT", L"0"},
    };
    if (request.recipe == 1) {
        entries.emplace_back(L"npm_config_userconfig", environment.userConfig);
        entries.emplace_back(L"npm_config_globalconfig", environment.globalConfig);
        entries.emplace_back(L"npm_config_cache", environment.npmCache);
        entries.emplace_back(L"npm_config_script_shell", environment.comSpec);
        entries.emplace_back(L"GIT_CONFIG_GLOBAL", environment.gitConfig);
        entries.emplace_back(L"GIT_CONFIG_SYSTEM", environment.gitConfig);
        entries.emplace_back(L"GIT_CONFIG_NOSYSTEM", L"1");
    } else {
        entries.emplace_back(L"GIT_CONFIG_GLOBAL", L"NUL");
        entries.emplace_back(L"GIT_CONFIG_SYSTEM", L"NUL");
        entries.emplace_back(L"GIT_CONFIG_NOSYSTEM", L"1");
        entries.emplace_back(L"GIT_ATTR_NOSYSTEM", L"1");
        entries.emplace_back(L"GIT_NO_REPLACE_OBJECTS", L"1");
        entries.emplace_back(L"GCM_INTERACTIVE", L"Never");
    }
    std::sort(entries.begin(), entries.end(), [](const auto& left, const auto& right) {
        return CompareStringOrdinal(left.first.c_str(), -1,
                                    right.first.c_str(), -1, TRUE) == CSTR_LESS_THAN;
    });

    environment.block.clear();
    for (const auto& entry : entries) {
        const std::wstring assignment = entry.first + L"=" + entry.second;
        environment.block.insert(environment.block.end(), assignment.begin(), assignment.end());
        environment.block.push_back(L'\0');
    }
    environment.block.push_back(L'\0');
    return true;
}

std::wstring QuoteWindowsArgument(const std::wstring& argument) {
    std::wstring quoted;
    quoted.push_back(L'\"');
    size_t backslashes = 0;
    for (wchar_t ch : argument) {
        if (ch == L'\\') {
            ++backslashes;
            continue;
        }
        if (ch == L'\"') {
            quoted.append(backslashes * 2 + 1, L'\\');
            quoted.push_back(L'\"');
            backslashes = 0;
            continue;
        }
        quoted.append(backslashes, L'\\');
        backslashes = 0;
        quoted.push_back(ch);
    }
    quoted.append(backslashes * 2, L'\\');
    quoted.push_back(L'\"');
    return quoted;
}

bool BuildCommandLine(const Request& request, const ChildEnvironment& environment,
                      std::vector<wchar_t>& commandLine, DWORD& error) {
    std::vector<std::wstring> arguments;
    if (request.recipe == 2 || request.recipe == 3) {
        if (request.genericMode == 2) {
            if (!SameOrdinal(request.genericExecutable, environment.comSpec)) {
                error = ERROR_INVALID_NAME;
                return false;
            }
            std::wstring command = QuoteWindowsArgument(request.genericExecutable) +
                L" /D /S /C \"" + request.genericCommandText + L"\"";
            if (command.size() >= 32766) {
                error = ERROR_FILENAME_EXCED_RANGE;
                return false;
            }
            commandLine.assign(command.begin(), command.end());
            commandLine.push_back(L'\0');
            return true;
        }
        if (request.genericMode == 1 &&
            IsBasename(request.genericExecutable, L"cmd.exe") &&
            request.genericArguments.size() == 3 &&
            SameOrdinal(request.genericArguments[0], L"/d") &&
            SameOrdinal(request.genericArguments[1], L"/c")) {
            // /C consumes one command-text argument; do not CRT-quote it or
            // join separate argv items into a new CMD command string.
            std::wstring command = QuoteWindowsArgument(request.genericExecutable) +
                L" /D /C " + request.genericArguments[2];
            if (command.size() >= 32766) {
                error = ERROR_FILENAME_EXCED_RANGE;
                return false;
            }
            commandLine.assign(command.begin(), command.end());
            commandLine.push_back(L'\0');
            return true;
        }
        arguments.push_back(request.genericExecutable);
        if (request.genericMode == 1) {
            arguments.insert(arguments.end(), request.genericArguments.begin(),
                             request.genericArguments.end());
        } else if (request.genericMode == 3) {
            arguments.push_back(L"-NoProfile");
            arguments.push_back(L"-NonInteractive");
            arguments.push_back(L"-Command");
            arguments.push_back(request.genericCommandText);
        } else {
            error = ERROR_INVALID_DATA;
            return false;
        }
        std::wstring command;
        for (const auto& argument : arguments) {
            if (!command.empty()) command.push_back(L' ');
            command += QuoteWindowsArgument(argument);
            if (command.size() >= 32766) {
                error = ERROR_FILENAME_EXCED_RANGE;
                return false;
            }
        }
        commandLine.assign(command.begin(), command.end());
        commandLine.push_back(L'\0');
        return true;
    }
    arguments.push_back(request.nodeExecutable);
    arguments.push_back(request.managerCli);
    if (request.manager == 1) {
        arguments.push_back(L"--userconfig=" + environment.userConfig);
        arguments.push_back(L"--globalconfig=" + environment.globalConfig);
        arguments.push_back(L"--script-shell=" + environment.comSpec);
        arguments.push_back(L"--cache=" + environment.npmCache);
        arguments.push_back(L"--audit=false");
        arguments.push_back(L"--fund=false");
        arguments.push_back(L"--node-options=");
    } else {
        arguments.push_back(L"--config.userconfig=" + environment.userConfig);
        arguments.push_back(L"--config.globalconfig=" + environment.globalConfig);
        arguments.push_back(L"--config.store-dir=" + environment.pnpmStore);
        arguments.push_back(L"--config.cache-dir=" + environment.pnpmCache);
        arguments.push_back(L"--config.node-options=");
        // Avoid an implicit `pnpm install` child process resolved through the
        // reduced PATH; C2C starts only the pinned CLI and approved recipe.
        arguments.push_back(L"--config.verify-deps-before-run=warn");
    }
    arguments.push_back(L"run");
    arguments.push_back(request.target);

    std::wstring command;
    for (const auto& argument : arguments) {
        if (!command.empty()) {
            command.push_back(L' ');
        }
        command += QuoteWindowsArgument(argument);
        if (command.size() >= 32766) {
            error = ERROR_FILENAME_EXCED_RANGE;
            return false;
        }
    }
    commandLine.assign(command.begin(), command.end());
    commandLine.push_back(L'\0');
    return true;
}

bool CreatePipePair(UniqueHandle& readEnd, UniqueHandle& writeEnd, DWORD& error) {
    SECURITY_ATTRIBUTES attributes{};
    attributes.nLength = sizeof(attributes);
    attributes.bInheritHandle = TRUE;
    HANDLE readRaw = INVALID_HANDLE_VALUE;
    HANDLE writeRaw = INVALID_HANDLE_VALUE;
    if (!CreatePipe(&readRaw, &writeRaw, &attributes, 0)) {
        error = GetLastError();
        return false;
    }
    readEnd.reset(readRaw);
    writeEnd.reset(writeRaw);
    if (!SetHandleInformation(readEnd.get(), HANDLE_FLAG_INHERIT, 0)) {
        error = GetLastError();
        return false;
    }
    return true;
}

bool EmitStreamFrame(HANDLE output, BYTE type, const BYTE* bytes, DWORD length) {
    DWORD error = ERROR_SUCCESS;
    if (!WriteFrame(output, type, bytes, length, error)) {
        DWORD expected = ERROR_SUCCESS;
        g_outputError.compare_exchange_strong(expected, error);
        return false;
    }
    return true;
}

void PumpOutput(HANDLE pipeRead, HANDLE helperOutput, BYTE type) {
    BYTE buffer[16 * 1024];
    for (;;) {
        DWORD received = 0;
        if (ReadFile(pipeRead, buffer, static_cast<DWORD>(sizeof(buffer)), &received, nullptr)) {
            if (received == 0) {
                return;
            }
            if (!EmitStreamFrame(helperOutput, type, buffer, received)) {
                return;
            }
            continue;
        }
        const DWORD error = GetLastError();
        if (error == ERROR_BROKEN_PIPE || error == ERROR_OPERATION_ABORTED) {
            return;
        }
        DWORD expected = ERROR_SUCCESS;
        g_outputError.compare_exchange_strong(expected, error);
        return;
    }
}

class ControlReader {
public:
    explicit ControlReader(HANDLE input) : input_(input) {}
    ControlReader(const ControlReader&) = delete;
    ControlReader& operator=(const ControlReader&) = delete;

    bool Start() {
        try {
            thread_ = std::thread(&ControlReader::Run, this);
        } catch (...) {
            state_.store(static_cast<int>(ControlEvent::ProtocolError));
            return false;
        }
        return true;
    }

    ControlEvent state() const {
        return static_cast<ControlEvent>(state_.load());
    }

    void WaitForEvent(DWORD maximumWaitMs) const {
        const auto stopAt = std::chrono::steady_clock::now() +
                            std::chrono::milliseconds(maximumWaitMs);
        while (state() == ControlEvent::None && std::chrono::steady_clock::now() < stopAt) {
            Sleep(1);
        }
    }

    void Stop() {
        stopping_.store(true);
        if (thread_.joinable()) {
            CancelSynchronousIo(thread_.native_handle());
            thread_.join();
        }
    }

    ~ControlReader() { Stop(); }

private:
    void Run() {
        for (;;) {
            if (stopping_.load()) {
                return;
            }
            BYTE controlByte = 0;
            DWORD received = 0;
            if (!ReadFile(input_, &controlByte, 1, &received, nullptr)) {
                const DWORD error = GetLastError();
                if (stopping_.load() && error == ERROR_OPERATION_ABORTED) {
                    return;
                }
                state_.store(static_cast<int>(ControlEvent::OwnerLost));
                return;
            }
            if (received == 0) {
                state_.store(static_cast<int>(ControlEvent::OwnerLost));
                return;
            }
            if (controlByte == 0x01) {
                if (state_.load() == static_cast<int>(ControlEvent::None)) {
                    state_.store(static_cast<int>(ControlEvent::Cancel));
                }
                continue;
            }
            state_.store(static_cast<int>(ControlEvent::ProtocolError));
            return;
        }
    }

    HANDLE input_ = INVALID_HANDLE_VALUE;
    std::atomic<int> state_{static_cast<int>(ControlEvent::None)};
    std::atomic<bool> stopping_{false};
    std::thread thread_;
};

bool CreateJob(UniqueHandle& job, DWORD& error) {
    job.reset(CreateJobObjectW(nullptr, nullptr));
    if (!job.valid()) {
        error = GetLastError();
        return false;
    }
    if (!SetHandleInformation(job.get(), HANDLE_FLAG_INHERIT, 0)) {
        error = GetLastError();
        return false;
    }
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job.get(), JobObjectExtendedLimitInformation,
                                 &limits, sizeof(limits))) {
        error = GetLastError();
        return false;
    }
    return true;
}

bool QueryActiveProcesses(HANDLE job, DWORD& active, DWORD& error) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
    if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation,
                                   &accounting, sizeof(accounting), nullptr)) {
        error = GetLastError();
        return false;
    }
    active = accounting.ActiveProcesses;
    return true;
}

bool WaitForJobZero(HANDLE job, HANDLE rootProcess, DWORD& error) {
    const auto deadline = std::chrono::steady_clock::now() +
                          std::chrono::milliseconds(kJobDrainLimitMs);
    DWORD lastQueryError = ERROR_SUCCESS;
    while (std::chrono::steady_clock::now() < deadline) {
        DWORD active = 0;
        if (QueryActiveProcesses(job, active, lastQueryError)) {
            if (active == 0) {
                if (rootProcess == nullptr || rootProcess == INVALID_HANDLE_VALUE) {
                    return true;
                }
                const DWORD waitResult = WaitForSingleObject(rootProcess, 10);
                if (waitResult == WAIT_OBJECT_0) return true;
                if (waitResult == WAIT_FAILED) {
                    error = GetLastError();
                    return false;
                }
                continue;
            }
        }
        Sleep(10);
    }
    error = lastQueryError == ERROR_SUCCESS ? ERROR_TIMEOUT : lastQueryError;
    return false;
}

bool TerminateUnverifiedSuspendedProcess(HANDLE process, DWORD& error) {
    if (process == nullptr || process == INVALID_HANDLE_VALUE) {
        error = ERROR_INVALID_HANDLE;
        return false;
    }
    // Startup cleanup only: the process is still suspended and has not run
    // package code. This uses the returned process HANDLE, never a PID.
    if (!TerminateProcess(process, ERROR_PROCESS_ABORTED)) {
        const DWORD terminateError = GetLastError();
        if (terminateError != ERROR_ACCESS_DENIED) {
            error = terminateError;
            return false;
        }
    }
    const DWORD waitResult = WaitForSingleObject(process, kJobDrainLimitMs);
    if (waitResult != WAIT_OBJECT_0) {
        error = waitResult == WAIT_FAILED ? GetLastError() : ERROR_TIMEOUT;
        return false;
    }
    return true;
}

void StopPump(std::thread& thread, HANDLE readEnd) {
    if (thread.joinable()) {
        CancelSynchronousIo(thread.native_handle());
        if (readEnd != nullptr && readEnd != INVALID_HANDLE_VALUE) {
            CloseHandle(readEnd);
        }
        thread.join();
    }
}

struct ProcAttributeList {
    PPROC_THREAD_ATTRIBUTE_LIST list = nullptr;
    void* storage = nullptr;

    ~ProcAttributeList() {
        if (list != nullptr) {
            DeleteProcThreadAttributeList(list);
        }
        if (storage != nullptr) {
            HeapFree(GetProcessHeap(), 0, storage);
        }
    }

    bool Initialize(DWORD attributeCount, DWORD& error) {
        SIZE_T size = 0;
        InitializeProcThreadAttributeList(nullptr, attributeCount, 0, &size);
        if (size == 0) {
            error = GetLastError();
            return false;
        }
        storage = HeapAlloc(GetProcessHeap(), 0, size);
        if (storage == nullptr) {
            error = ERROR_NOT_ENOUGH_MEMORY;
            return false;
        }
        list = static_cast<PPROC_THREAD_ATTRIBUTE_LIST>(storage);
        if (!InitializeProcThreadAttributeList(list, attributeCount, 0, &size)) {
            error = GetLastError();
            list = nullptr;
            return false;
        }
        return true;
    }
};

bool CreateSuspendedChild(const Request& request, const ChildEnvironment& environment,
                          HANDLE job, UniqueHandle& stdoutRead, UniqueHandle& stdoutWrite,
                          UniqueHandle& stderrRead, UniqueHandle& stderrWrite,
                          UniqueHandle& nullInput, UniqueHandle& process,
                          UniqueHandle& primaryThread, DWORD& error) {
    if (!CreatePipePair(stdoutRead, stdoutWrite, error) ||
        !CreatePipePair(stderrRead, stderrWrite, error)) {
        return false;
    }

    SECURITY_ATTRIBUTES nullAttributes{};
    nullAttributes.nLength = sizeof(nullAttributes);
    nullAttributes.bInheritHandle = TRUE;
    nullInput.reset(CreateFileW(L"NUL", GENERIC_READ,
                                FILE_SHARE_READ | FILE_SHARE_WRITE,
                                &nullAttributes, OPEN_EXISTING,
                                FILE_ATTRIBUTE_NORMAL, nullptr));
    if (!nullInput.valid()) {
        error = GetLastError();
        return false;
    }

    std::vector<wchar_t> commandLine;
    if (!BuildCommandLine(request, environment, commandLine, error)) {
        return false;
    }

    ProcAttributeList attributes;
    if (!attributes.Initialize(2, error)) {
        return false;
    }
    HANDLE jobHandle = job;
    if (!UpdateProcThreadAttribute(attributes.list, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST,
                                   &jobHandle, sizeof(jobHandle), nullptr, nullptr)) {
        error = GetLastError();
        return false;
    }
    HANDLE inheritedHandles[] = {nullInput.get(), stdoutWrite.get(), stderrWrite.get()};
    if (!UpdateProcThreadAttribute(attributes.list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                                   inheritedHandles, sizeof(inheritedHandles), nullptr, nullptr)) {
        error = GetLastError();
        return false;
    }

    STARTUPINFOEXW startup{};
    startup.StartupInfo.cb = sizeof(startup);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = nullInput.get();
    startup.StartupInfo.hStdOutput = stdoutWrite.get();
    startup.StartupInfo.hStdError = stderrWrite.get();
    startup.lpAttributeList = attributes.list;

    PROCESS_INFORMATION processInfo{};
    DWORD creationFlags = CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT |
                          CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW;
    const wchar_t* applicationName = request.recipe == 2 || request.recipe == 3
        ? request.genericExecutable.c_str()
        : request.nodeExecutable.c_str();
    const wchar_t* workingDirectory = request.recipe == 2 || request.recipe == 3
        ? request.genericCwd.c_str()
        : request.cwd.c_str();
    if (!CreateProcessW(applicationName, commandLine.data(),
                        nullptr, nullptr, TRUE, creationFlags,
                        const_cast<wchar_t*>(environment.block.data()), workingDirectory,
                        &startup.StartupInfo, &processInfo)) {
        error = GetLastError();
        return false;
    }
    process.reset(processInfo.hProcess);
    primaryThread.reset(processInfo.hThread);
    return true;
}

bool VerifyChildInJob(HANDLE process, HANDLE job, DWORD& error) {
    BOOL isMember = FALSE;
    if (!IsProcessInJob(process, job, &isMember)) {
        error = GetLastError();
        return false;
    }
    if (!isMember) {
        error = ERROR_ACCESS_DENIED;
        return false;
    }
    return true;
}

bool EnsureCurrentTokenNotElevated(DWORD& error) {
    UniqueModule advapi(LoadLibraryExW(L"advapi32.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32));
    if (advapi.value == nullptr) {
        error = GetLastError();
        return false;
    }
    const auto openProcessToken = reinterpret_cast<decltype(&OpenProcessToken)>(
        GetProcAddress(advapi.value, "OpenProcessToken"));
    const auto getTokenInformation = reinterpret_cast<decltype(&GetTokenInformation)>(
        GetProcAddress(advapi.value, "GetTokenInformation"));
    if (openProcessToken == nullptr || getTokenInformation == nullptr) {
        error = ERROR_PROC_NOT_FOUND;
        return false;
    }
    HANDLE tokenRaw = INVALID_HANDLE_VALUE;
    if (!openProcessToken(GetCurrentProcess(), TOKEN_QUERY, &tokenRaw)) {
        error = GetLastError();
        return false;
    }
    UniqueHandle token(tokenRaw);
    TOKEN_ELEVATION elevation{};
    DWORD returned = 0;
    if (!getTokenInformation(token.get(), TokenElevation, &elevation,
                              sizeof(elevation), &returned)) {
        error = GetLastError();
        return false;
    }
    if (returned != sizeof(elevation)) {
        error = ERROR_INVALID_DATA;
        return false;
    }
    if (elevation.TokenIsElevated != 0) {
        error = ERROR_ACCESS_DENIED;
        return false;
    }
    return true;
}

DWORD GetChildExitCode(HANDLE process) {
    DWORD exitCode = kNoChildExitCode;
    if (process == nullptr || process == INVALID_HANDLE_VALUE ||
        !GetExitCodeProcess(process, &exitCode)) {
        return kNoChildExitCode;
    }
    return exitCode;
}

Outcome OutcomeFromControl(ControlEvent event) {
    return event == ControlEvent::Cancel ? Outcome::Cancelled : Outcome::HelperError;
}

void SetFirstError(DWORD candidate, DWORD& error) {
    if (error == ERROR_SUCCESS) {
        error = candidate == ERROR_SUCCESS ? ERROR_GEN_FAILURE : candidate;
    }
}

std::uint64_t ElapsedMicroseconds(std::chrono::steady_clock::time_point start) {
    return static_cast<std::uint64_t>(
        std::chrono::duration_cast<std::chrono::microseconds>(
            std::chrono::steady_clock::now() - start).count());
}

bool AtomicFileAttributes(HANDLE file, FILE_ATTRIBUTE_TAG_INFO& info, DWORD& error) {
    if (!GetFileInformationByHandleEx(file, FileAttributeTagInfo, &info, sizeof(info))) {
        error = GetLastError();
        return false;
    }
    if ((info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
        error = ERROR_REPARSE_TAG_INVALID;
        return false;
    }
    if ((info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) {
        error = ERROR_DIRECTORY;
        return false;
    }
    return true;
}

bool AtomicSecurityDescriptor(HANDLE file, std::wstring& sddl, DWORD& error) {
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    const SECURITY_INFORMATION sections = OWNER_SECURITY_INFORMATION |
        GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION;
    const DWORD status = GetSecurityInfo(file, SE_FILE_OBJECT, sections,
        nullptr, nullptr, nullptr, nullptr, &descriptor);
    if (status != ERROR_SUCCESS) {
        error = status;
        return false;
    }
    LPWSTR text = nullptr;
    ULONG length = 0;
    const BOOL converted = ConvertSecurityDescriptorToStringSecurityDescriptorW(
        descriptor, SDDL_REVISION_1, sections, &text, &length);
    if (!converted) {
        error = GetLastError();
        LocalFree(descriptor);
        return false;
    }
    sddl.assign(text, length > 0 ? length - 1 : 0);
    LocalFree(text);
    LocalFree(descriptor);
    return true;
}

struct AtomicSecurityParts {
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    PSID owner = nullptr;
    PSID group = nullptr;
    PACL dacl = nullptr;
    SECURITY_DESCRIPTOR_CONTROL control = 0;
};

void FreeAtomicSecurityParts(AtomicSecurityParts& parts) {
    if (parts.descriptor != nullptr) LocalFree(parts.descriptor);
    parts = {};
}

bool ReadAtomicSecurityParts(HANDLE file, AtomicSecurityParts& parts, DWORD& error) {
    const SECURITY_INFORMATION sections = OWNER_SECURITY_INFORMATION |
        GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION;
    error = GetSecurityInfo(file, SE_FILE_OBJECT, sections, &parts.owner, &parts.group,
        &parts.dacl, nullptr, &parts.descriptor);
    if (error != ERROR_SUCCESS) return false;
    DWORD revision = 0;
    if (!GetSecurityDescriptorControl(parts.descriptor, &parts.control, &revision)) {
        error = GetLastError();
        FreeAtomicSecurityParts(parts);
        return false;
    }
    return true;
}

bool SameAtomicSid(PSID left, PSID right) {
    if (left == nullptr || right == nullptr) return left == right;
    return EqualSid(left, right) != FALSE;
}

bool AtomicCopySecurityDescriptor(HANDLE target, HANDLE replacement,
                                 const std::wstring& expectedSddl, DWORD& error) {
    AtomicSecurityParts targetParts;
    AtomicSecurityParts replacementParts;
    if (!ReadAtomicSecurityParts(target, targetParts, error)) return false;
    if (!ReadAtomicSecurityParts(replacement, replacementParts, error)) {
        FreeAtomicSecurityParts(targetParts);
        return false;
    }

    const bool ownerDiffers = !SameAtomicSid(targetParts.owner, replacementParts.owner);
    const bool groupDiffers = !SameAtomicSid(targetParts.group, replacementParts.group);
    std::wstring replacementSddl;
    if (!AtomicSecurityDescriptor(replacement, replacementSddl, error)) {
        FreeAtomicSecurityParts(replacementParts);
        FreeAtomicSecurityParts(targetParts);
        return false;
    }
    const bool descriptorDiffers = !SameOrdinal(replacementSddl, expectedSddl);

    SECURITY_INFORMATION securityInfo = 0;
    if (ownerDiffers) securityInfo |= OWNER_SECURITY_INFORMATION;
    if (groupDiffers) securityInfo |= GROUP_SECURITY_INFORMATION;
    if (descriptorDiffers) {
        securityInfo |= DACL_SECURITY_INFORMATION |
            ((targetParts.control & SE_DACL_PROTECTED) != 0
                ? PROTECTED_DACL_SECURITY_INFORMATION
                : UNPROTECTED_DACL_SECURITY_INFORMATION);
    }
    if (securityInfo == 0) {
        FreeAtomicSecurityParts(replacementParts);
        FreeAtomicSecurityParts(targetParts);
        return true;
    }

    UniqueHandle ownerWritableReplacement;
    HANDLE securityHandle = replacement;
    if (ownerDiffers || groupDiffers) {
        ownerWritableReplacement.reset(ReOpenFile(replacement,
            READ_CONTROL | WRITE_DAC | WRITE_OWNER,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, 0));
        if (!ownerWritableReplacement.valid()) {
            error = GetLastError();
            FreeAtomicSecurityParts(replacementParts);
            FreeAtomicSecurityParts(targetParts);
            return false;
        }
        std::wstring originalIdentity;
        std::wstring reopenedIdentity;
        if (!FileIdentity(replacement, originalIdentity, error) ||
            !FileIdentity(ownerWritableReplacement.get(), reopenedIdentity, error) ||
            !SameOrdinal(originalIdentity, reopenedIdentity)) {
            if (error == ERROR_SUCCESS) error = ERROR_FILE_INVALID;
            FreeAtomicSecurityParts(replacementParts);
            FreeAtomicSecurityParts(targetParts);
            return false;
        }
        securityHandle = ownerWritableReplacement.get();
    }

    error = SetSecurityInfo(securityHandle, SE_FILE_OBJECT, securityInfo,
        ownerDiffers ? targetParts.owner : nullptr,
        groupDiffers ? targetParts.group : nullptr,
        descriptorDiffers ? targetParts.dacl : nullptr, nullptr);
    FreeAtomicSecurityParts(replacementParts);
    FreeAtomicSecurityParts(targetParts);
    if (error != ERROR_SUCCESS) return false;

    std::wstring actualSddl;
    if (!AtomicSecurityDescriptor(replacement, actualSddl, error)) return false;
    if (!SameOrdinal(actualSddl, expectedSddl)) {
        error = ERROR_INVALID_SECURITY_DESCR;
        return false;
    }
    return true;
}

bool AtomicCopyAlternateDataStreams(const std::wstring& destination,
                                    const std::wstring& replacement, DWORD& error) {
    WIN32_FIND_STREAM_DATA stream{};
    HANDLE search = FindFirstStreamW(destination.c_str(), FindStreamInfoStandard, &stream, 0);
    if (search == INVALID_HANDLE_VALUE) {
        error = GetLastError();
        if (error == ERROR_HANDLE_EOF) error = ERROR_SUCCESS;
        return error == ERROR_SUCCESS;
    }

    bool copied = true;
    do {
        if (CompareStringOrdinal(stream.cStreamName, -1, L"::$DATA", -1, TRUE) == CSTR_EQUAL) {
            continue;
        }
        if (stream.cStreamName[0] != L':' ||
            std::wcschr(stream.cStreamName, L'\\') != nullptr ||
            std::wcschr(stream.cStreamName, L'/') != nullptr) {
            error = ERROR_INVALID_NAME;
            copied = false;
            break;
        }

        const std::wstring streamName(stream.cStreamName);
        const std::wstring sourceStream = destination + streamName;
        const std::wstring replacementStream = replacement + streamName;
        UniqueHandle input(CreateFileW(sourceStream.c_str(), GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
            OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
        if (!input.valid()) {
            error = GetLastError();
            copied = false;
            break;
        }
        UniqueHandle output(CreateFileW(replacementStream.c_str(), GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
            CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr));
        if (!output.valid()) {
            error = GetLastError();
            copied = false;
            break;
        }

        std::array<char, 64 * 1024> buffer{};
        for (;;) {
            DWORD bytesRead = 0;
            if (!ReadFile(input.get(), buffer.data(), static_cast<DWORD>(buffer.size()),
                          &bytesRead, nullptr)) {
                error = GetLastError();
                copied = false;
                break;
            }
            if (bytesRead == 0) break;
            DWORD offset = 0;
            while (offset < bytesRead) {
                DWORD bytesWritten = 0;
                if (!WriteFile(output.get(), buffer.data() + offset, bytesRead - offset,
                               &bytesWritten, nullptr) || bytesWritten == 0) {
                    error = GetLastError();
                    if (error == ERROR_SUCCESS) error = ERROR_WRITE_FAULT;
                    copied = false;
                    break;
                }
                offset += bytesWritten;
            }
            if (!copied) break;
        }
        if (copied && !FlushFileBuffers(output.get())) {
            error = GetLastError();
            copied = false;
        }
        if (!copied) break;
    } while (FindNextStreamW(search, &stream));

    if (copied) {
        const DWORD enumerationError = GetLastError();
        if (enumerationError != ERROR_HANDLE_EOF) {
            error = enumerationError;
            copied = false;
        }
    }
    if (!FindClose(search) && copied) {
        error = GetLastError();
        copied = false;
    }
    if (copied) error = ERROR_SUCCESS;
    return copied;
}

bool AtomicPrepareReplacement(const std::wstring& destination,
                              const std::wstring& replacementPath,
                              HANDLE target, HANDLE replacement,
                              const FILE_ATTRIBUTE_TAG_INFO& targetAttributes,
                              const std::wstring& targetSddl, DWORD& error) {
    const DWORD unsupportedStorageAttributes = FILE_ATTRIBUTE_COMPRESSED |
        FILE_ATTRIBUTE_ENCRYPTED | FILE_ATTRIBUTE_SPARSE_FILE | FILE_ATTRIBUTE_OFFLINE;
    if ((targetAttributes.FileAttributes & unsupportedStorageAttributes) != 0) {
        error = ERROR_NOT_SUPPORTED;
        return false;
    }

    if (!AtomicCopyAlternateDataStreams(destination, replacementPath, error) ||
        !AtomicCopySecurityDescriptor(target, replacement, targetSddl, error)) {
        return false;
    }

    FILE_BASIC_INFO targetBasic{};
    FILE_BASIC_INFO replacementBasic{};
    if (!GetFileInformationByHandleEx(target, FileBasicInfo, &targetBasic, sizeof(targetBasic)) ||
        !GetFileInformationByHandleEx(replacement, FileBasicInfo, &replacementBasic, sizeof(replacementBasic))) {
        error = GetLastError();
        return false;
    }

    const DWORD preserveMask = FILE_ATTRIBUTE_ARCHIVE | FILE_ATTRIBUTE_HIDDEN |
        FILE_ATTRIBUTE_SYSTEM | FILE_ATTRIBUTE_NOT_CONTENT_INDEXED | FILE_ATTRIBUTE_TEMPORARY;
    const DWORD desiredAttributes = (replacementBasic.FileAttributes & ~preserveMask) |
        (targetBasic.FileAttributes & preserveMask);
    FILE_BASIC_INFO update{};
    update.CreationTime = targetBasic.CreationTime;
    update.FileAttributes = desiredAttributes;
    if (!SetFileInformationByHandle(replacement, FileBasicInfo, &update, sizeof(update))) {
        error = GetLastError();
        return false;
    }

    FILE_BASIC_INFO verifiedBasic{};
    if (!GetFileInformationByHandleEx(replacement, FileBasicInfo, &verifiedBasic, sizeof(verifiedBasic))) {
        error = GetLastError();
        return false;
    }
    const DWORD verifyMask = FILE_ATTRIBUTE_READONLY | FILE_ATTRIBUTE_ARCHIVE |
        FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM | FILE_ATTRIBUTE_NOT_CONTENT_INDEXED |
        FILE_ATTRIBUTE_COMPRESSED | FILE_ATTRIBUTE_ENCRYPTED | FILE_ATTRIBUTE_SPARSE_FILE |
        FILE_ATTRIBUTE_OFFLINE | FILE_ATTRIBUTE_TEMPORARY;
    if (verifiedBasic.CreationTime.QuadPart != targetBasic.CreationTime.QuadPart ||
        (verifiedBasic.FileAttributes & verifyMask) != (targetBasic.FileAttributes & verifyMask)) {
        error = ERROR_INVALID_DATA;
        return false;
    }
    if (!FlushFileBuffers(replacement)) {
        error = GetLastError();
        return false;
    }
    return true;
}

bool AtomicRenameReplace(HANDLE replacement, const std::wstring& destination, DWORD& error) {
    const std::size_t fileNameBytes = destination.size() * sizeof(wchar_t);
    const std::size_t structureBytes = sizeof(FILE_RENAME_INFO);
    if (fileNameBytes == 0 ||
        fileNameBytes > static_cast<std::size_t>(MAXDWORD) - structureBytes) {
        error = ERROR_INVALID_NAME;
        return false;
    }
    // Windows requires at least sizeof(FILE_RENAME_INFO) + FileNameLength.
    // The zero-filled tail also leaves a terminating WCHAR after the counted name.
    std::vector<BYTE> storage(structureBytes + fileNameBytes, 0);
    auto* renameInfo = reinterpret_cast<FILE_RENAME_INFO*>(storage.data());
    // Flags 0x1 | 0x2: replace existing, then use POSIX-style name replacement.
    renameInfo->Flags = FILE_RENAME_FLAG_REPLACE_IF_EXISTS |
        FILE_RENAME_FLAG_POSIX_SEMANTICS;
    renameInfo->RootDirectory = nullptr;
    renameInfo->FileNameLength = static_cast<DWORD>(fileNameBytes);
    std::memcpy(renameInfo->FileName, destination.data(), fileNameBytes);
    if (!SetFileInformationByHandle(replacement, FileRenameInfoEx,
                                    renameInfo, static_cast<DWORD>(storage.size()))) {
        error = GetLastError();
        return false;
    }
    return true;
}

bool AtomicResult(const std::string& payload, DWORD& error) {
    const HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
    if (output == nullptr || output == INVALID_HANDLE_VALUE) {
        error = ERROR_INVALID_HANDLE;
        return false;
    }
    const std::string line = "C2C_RESULT|" + payload + "\n";
    return WriteAll(output, line.data(), static_cast<DWORD>(line.size()), error);
}

bool AtomicOpen(const std::wstring& path, UniqueHandle& handle, DWORD& error,
                DWORD desiredAccess = GENERIC_READ | READ_CONTROL,
                DWORD shareMode = FILE_SHARE_READ | FILE_SHARE_DELETE,
                DWORD extraFlags = 0) {
    for (DWORD attempt = 0; attempt <= 10; ++attempt) {
        handle.reset(CreateFileW(path.c_str(), desiredAccess, shareMode, nullptr,
            OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | extraFlags, nullptr));
        if (handle.valid()) break;
        error = GetLastError();
        if ((error != ERROR_SHARING_VIOLATION && error != ERROR_LOCK_VIOLATION) || attempt == 10) {
            return false;
        }
        Sleep(10);
    }
    if (GetFileType(handle.get()) != FILE_TYPE_DISK) {
        error = ERROR_INVALID_FUNCTION;
        return false;
    }
    FILE_ATTRIBUTE_TAG_INFO attributes{};
    if (!AtomicFileAttributes(handle.get(), attributes, error)) return false;
    return true;
}

int RunAtomicReplace(const std::wstring& destination, const std::wstring& source,
                     const std::wstring& expectedHash, const std::wstring& expectedNewHash,
                     const std::wstring& expectedVolumeText, const std::wstring& expectedIndexText) {
    const auto validationStart = std::chrono::steady_clock::now();
    DWORD error = ERROR_SUCCESS;
    std::uint64_t expectedVolume = 0;
    std::uint64_t expectedIndex = 0;
    if (!IsHex(expectedHash, 64) || !IsHex(expectedNewHash, 64) ||
        !ParseUnsignedDecimal(expectedVolumeText, expectedVolume) ||
        !ParseUnsignedDecimal(expectedIndexText, expectedIndex)) {
        AtomicResult("ERROR|87|preflight|0|0|0", error);
        return 0;
    }

    std::wstring canonicalDestination;
    std::wstring canonicalSource;
    if (!ValidateCanonicalPath(destination, false, canonicalDestination, error) ||
        !ValidateCanonicalPath(source, false, canonicalSource, error) ||
        !SameOrdinal(ParentDirectory(canonicalDestination), ParentDirectory(canonicalSource))) {
        if (error == ERROR_SUCCESS) error = ERROR_INVALID_NAME;
        AtomicResult("ERROR|" + std::to_string(error) + "|preflight|0|0|0", error);
        return 0;
    }

    // Serialize C2C publishers for one original file identity. This gives
    // ordinary competing C2C writers one winner; external same-user path swaps
    // remain outside the Practical Atomic Edit guarantee.
    const std::wstring mutexName = L"Local\\C2C_PracticalAtomicEdit_" +
        expectedVolumeText + L"_" + expectedIndexText;
    AtomicEditMutex publicationLock;
    if (!publicationLock.acquire(mutexName, error)) {
        AtomicResult("ERROR|" + std::to_string(error) + "|final-validation|0|" +
            std::to_string(ElapsedMicroseconds(validationStart)) + "|0", error);
        return 0;
    }

    UniqueHandle target;
    // Requiring target write and DELETE access honors its DACL even when the
    // parent directory separately grants DELETE_CHILD.
    if (!AtomicOpen(canonicalDestination, target, error,
                    GENERIC_READ | READ_CONTROL | FILE_WRITE_DATA | DELETE)) {
        AtomicResult("ERROR|" + std::to_string(error) + "|preflight|0|0|0", error);
        return 0;
    }
    FILE_ATTRIBUTE_TAG_INFO targetAttributes{};
    if (!AtomicFileAttributes(target.get(), targetAttributes, error)) {
        AtomicResult("ERROR|" + std::to_string(error) + "|preflight|0|0|0", error);
        return 0;
    }
    if ((targetAttributes.FileAttributes & FILE_ATTRIBUTE_READONLY) != 0) {
        AtomicResult("READONLY|" + std::to_string(ElapsedMicroseconds(validationStart)), error);
        return 0;
    }

    std::wstring targetIdentity;
    std::wstring targetHash;
    if (!FileIdentity(target.get(), targetIdentity, error) ||
        !Sha256(target.get(), targetHash, error)) {
        AtomicResult("ERROR|" + std::to_string(error) + "|final-validation|0|" +
            std::to_string(ElapsedMicroseconds(validationStart)) + "|0", error);
        return 0;
    }
    std::wostringstream expectedIdentity;
    expectedIdentity << std::hex << std::nouppercase << expectedVolume << L":" << expectedIndex;
    if (!SameOrdinal(targetIdentity, expectedIdentity.str()) ||
        !SameOrdinal(targetHash, expectedHash)) {
        std::string currentHash;
        if (!ToAscii(targetHash, currentHash)) currentHash = std::string(64, '0');
        AtomicResult("STALE|" + currentHash + "|" +
            std::to_string(ElapsedMicroseconds(validationStart)), error);
        return 0;
    }

    std::wstring aclBefore;
    if (!AtomicSecurityDescriptor(target.get(), aclBefore, error)) {
        AtomicResult("ERROR|" + std::to_string(error) + "|final-validation|0|" +
            std::to_string(ElapsedMicroseconds(validationStart)) + "|0", error);
        return 0;
    }

    // Confirm the destination name still resolves to the handle whose bytes were
    // hashed. The held handle denies ordinary in-place writes and allows a single
    // POSIX-style rename replacement. Same-user adversarial path swaps remain
    // outside the Practical Atomic Edit guarantee.
    UniqueHandle pathCheck;
    if (!AtomicOpen(canonicalDestination, pathCheck, error,
                    GENERIC_READ | READ_CONTROL,
                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)) {
        AtomicResult("ERROR|" + std::to_string(error) + "|final-validation|0|" +
            std::to_string(ElapsedMicroseconds(validationStart)) + "|0", error);
        return 0;
    }
    std::wstring pathIdentity;
    if (!FileIdentity(pathCheck.get(), pathIdentity, error)) {
        AtomicResult("ERROR|" + std::to_string(error) + "|final-validation|0|" +
            std::to_string(ElapsedMicroseconds(validationStart)) + "|0", error);
        return 0;
    }
    if (!SameOrdinal(pathIdentity, targetIdentity)) {
        std::string currentHash;
        std::wstring pathHash;
        if (Sha256(pathCheck.get(), pathHash, error) && !ToAscii(pathHash, currentHash)) {
            currentHash = std::string(64, '0');
        }
        if (currentHash.empty()) currentHash = std::string(64, '0');
        AtomicResult("STALE|" + currentHash + "|" +
            std::to_string(ElapsedMicroseconds(validationStart)), error);
        return 0;
    }
    pathCheck.reset();

    UniqueHandle replacement;
    if (!AtomicOpen(canonicalSource, replacement, error,
                    GENERIC_READ | GENERIC_WRITE | READ_CONTROL | DELETE | WRITE_DAC,
                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                    FILE_FLAG_WRITE_THROUGH)) {
        AtomicResult("ERROR|" + std::to_string(error) + "|final-validation|0|" +
            std::to_string(ElapsedMicroseconds(validationStart)) + "|0", error);
        return 0;
    }
    std::wstring replacementHash;
    if (!Sha256(replacement.get(), replacementHash, error) ||
        !SameOrdinal(replacementHash, expectedNewHash)) {
        if (error == ERROR_SUCCESS) error = ERROR_INVALID_DATA;
        AtomicResult("ERROR|" + std::to_string(error) + "|final-validation|0|" +
            std::to_string(ElapsedMicroseconds(validationStart)) + "|0", error);
        return 0;
    }
    if (!AtomicPrepareReplacement(canonicalDestination, canonicalSource, target.get(),
                                  replacement.get(), targetAttributes, aclBefore, error)) {
        AtomicResult("ERROR|" + std::to_string(error) + "|final-validation|0|" +
            std::to_string(ElapsedMicroseconds(validationStart)) + "|0", error);
        return 0;
    }
    std::wstring preparedHash;
    if (!Sha256(replacement.get(), preparedHash, error) ||
        !SameOrdinal(preparedHash, expectedNewHash)) {
        if (error == ERROR_SUCCESS) error = ERROR_INVALID_DATA;
        AtomicResult("ERROR|" + std::to_string(error) + "|final-validation|0|" +
            std::to_string(ElapsedMicroseconds(validationStart)) + "|0", error);
        return 0;
    }

    const std::uint64_t validationUs = ElapsedMicroseconds(validationStart);
    const auto replaceStart = std::chrono::steady_clock::now();
    if (!AtomicRenameReplace(replacement.get(), canonicalDestination, error)) {
        AtomicResult("ERROR|" + std::to_string(error) + "|publish|0|" +
            std::to_string(validationUs) + "|0", error);
        return 0;
    }
    const std::uint64_t replaceUs = ElapsedMicroseconds(replaceStart);
    target.reset();
    replacement.reset();

    const auto verificationStart = std::chrono::steady_clock::now();
    UniqueHandle finalFile;
    if (!AtomicOpen(canonicalDestination, finalFile, error)) {
        AtomicResult("ERROR|" + std::to_string(error) + "|post-verification|1|" +
            std::to_string(validationUs) + "|" +
            std::to_string(ElapsedMicroseconds(verificationStart)) + "|", error);
        return 0;
    }
    FILE_ATTRIBUTE_TAG_INFO finalAttributes{};
    std::wstring finalHash;
    std::wstring aclAfter;
    if (!AtomicFileAttributes(finalFile.get(), finalAttributes, error) ||
        !Sha256(finalFile.get(), finalHash, error) ||
        !AtomicSecurityDescriptor(finalFile.get(), aclAfter, error)) {
        AtomicResult("ERROR|" + std::to_string(error) + "|post-verification|1|" +
            std::to_string(validationUs) + "|" +
            std::to_string(ElapsedMicroseconds(verificationStart)) + "|", error);
        return 0;
    }
    const DWORD verifyMask = FILE_ATTRIBUTE_READONLY | FILE_ATTRIBUTE_ARCHIVE |
        FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM | FILE_ATTRIBUTE_NOT_CONTENT_INDEXED |
        FILE_ATTRIBUTE_COMPRESSED | FILE_ATTRIBUTE_ENCRYPTED | FILE_ATTRIBUTE_SPARSE_FILE |
        FILE_ATTRIBUTE_OFFLINE | FILE_ATTRIBUTE_TEMPORARY;
    if (!SameOrdinal(finalHash, expectedNewHash)) {
        std::string actual;
        if (!ToAscii(finalHash, actual)) actual = std::string(64, '0');
        AtomicResult("ERROR|13|post-verification|1|" + std::to_string(validationUs) + "|" +
            std::to_string(ElapsedMicroseconds(verificationStart)) + "|" + actual, error);
        return 0;
    }
    if ((finalAttributes.FileAttributes & verifyMask) !=
            (targetAttributes.FileAttributes & verifyMask) ||
        !SameOrdinal(aclBefore, aclAfter)) {
        std::string actual;
        if (!ToAscii(finalHash, actual)) actual = std::string(64, '0');
        AtomicResult("ERROR|13|post-verification|1|" + std::to_string(validationUs) + "|" +
            std::to_string(ElapsedMicroseconds(verificationStart)) + "|" + actual, error);
        return 0;
    }

    std::string finalHashAscii;
    if (!ToAscii(finalHash, finalHashAscii)) finalHashAscii = std::string(64, '0');
    AtomicResult("OK|" + finalHashAscii + "|" + std::to_string(validationUs) + "|" +
        std::to_string(replaceUs) + "|" + std::to_string(ElapsedMicroseconds(verificationStart)), error);
    return 0;
}

bool ValidateDurablePublishPaths(const std::wstring& destination, const std::wstring& source,
                                std::wstring& canonicalDestination,
                                std::wstring& canonicalSource, DWORD& error) {
    if (destination.empty() || destination.size() > 32760 ||
        !IsAsciiDriveAbsolutePath(destination) ||
        destination.find(L'/') != std::wstring::npos || destination.back() == L'\\') {
        error = ERROR_INVALID_NAME;
        return false;
    }
    const DWORD needed = GetFullPathNameW(destination.c_str(), 0, nullptr, nullptr);
    if (needed == 0 || needed > 32760) {
        error = needed == 0 ? GetLastError() : ERROR_FILENAME_EXCED_RANGE;
        return false;
    }
    std::vector<wchar_t> fullBuffer(static_cast<size_t>(needed) + 1, L'\0');
    const DWORD fullLength = GetFullPathNameW(destination.c_str(),
        static_cast<DWORD>(fullBuffer.size()), fullBuffer.data(), nullptr);
    if (fullLength == 0 || fullLength >= fullBuffer.size() ||
        CompareStringOrdinal(destination.c_str(), -1, fullBuffer.data(), -1, TRUE) != CSTR_EQUAL) {
        error = fullLength == 0 ? GetLastError() : ERROR_INVALID_NAME;
        return false;
    }
    const std::wstring leaf = PathBasename(destination);
    if (leaf.empty() || leaf == L"." || leaf == L".." || leaf.back() == L'.' || leaf.back() == L' ' ||
        leaf.find_first_of(L"<>:\"|?*") != std::wstring::npos) {
        error = ERROR_INVALID_NAME;
        return false;
    }
    const std::wstring requestedParent = ParentDirectory(destination);
    std::wstring canonicalParent;
    if (!ValidateCanonicalPath(requestedParent, true, canonicalParent, error) ||
        !ValidateCanonicalPath(source, false, canonicalSource, error) ||
        !SameOrdinal(ParentDirectory(canonicalSource), canonicalParent)) {
        if (error == ERROR_SUCCESS) error = ERROR_INVALID_NAME;
        return false;
    }
    canonicalDestination = canonicalParent;
    if (canonicalDestination.back() != L'\\') canonicalDestination.push_back(L'\\');
    canonicalDestination += leaf;

    const DWORD attributes = GetFileAttributesW(canonicalDestination.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES) {
        const DWORD attributeError = GetLastError();
        if (attributeError != ERROR_FILE_NOT_FOUND && attributeError != ERROR_PATH_NOT_FOUND) {
            error = attributeError;
            return false;
        }
    } else if ((attributes & FILE_ATTRIBUTE_DIRECTORY) != 0 ||
               (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
        error = (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0 ? ERROR_DIRECTORY : ERROR_REPARSE_TAG_INVALID;
        return false;
    }

    wchar_t volumeRoot[MAX_PATH]{};
    wchar_t fileSystem[MAX_PATH]{};
    if (!GetVolumePathNameW(canonicalSource.c_str(), volumeRoot, MAX_PATH) ||
        !GetVolumeInformationW(volumeRoot, nullptr, 0, nullptr, nullptr, nullptr, fileSystem, MAX_PATH)) {
        error = GetLastError();
        return false;
    }
    if (GetDriveTypeW(volumeRoot) != DRIVE_FIXED || !SameOrdinal(fileSystem, L"NTFS")) {
        error = ERROR_NOT_SUPPORTED;
        return false;
    }
    return true;
}

int RunDurableAtomicPublish(const std::wstring& destination, const std::wstring& source,
                            const std::wstring& expectedNewHash) {
    const auto validationStart = std::chrono::steady_clock::now();
    DWORD error = ERROR_SUCCESS;
    if (!IsHex(expectedNewHash, 64)) {
        AtomicResult("ERROR|87|preflight|0", error);
        return 0;
    }
    std::wstring canonicalDestination;
    std::wstring canonicalSource;
    if (!ValidateDurablePublishPaths(destination, source, canonicalDestination, canonicalSource, error)) {
        AtomicResult("ERROR|" + std::to_string(error) + "|preflight|0", error);
        return 0;
    }

    UniqueHandle replacement;
    if (!AtomicOpen(canonicalSource, replacement, error,
                    GENERIC_READ | GENERIC_WRITE | READ_CONTROL | DELETE,
                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                    FILE_FLAG_WRITE_THROUGH)) {
        AtomicResult("ERROR|" + std::to_string(error) + "|preflight|0", error);
        return 0;
    }
    std::wstring tempHash;
    if (!Sha256(replacement.get(), tempHash, error) || !SameOrdinal(tempHash, expectedNewHash)) {
        if (error == ERROR_SUCCESS) error = ERROR_INVALID_DATA;
        AtomicResult("ERROR|" + std::to_string(error) + "|preflight|0", error);
        return 0;
    }

    const auto flushStart = std::chrono::steady_clock::now();
    if (!FlushFileBuffers(replacement.get())) {
        error = GetLastError();
        AtomicResult("ERROR|" + std::to_string(error) + "|flush|0", error);
        return 0;
    }
    const std::uint64_t flushUs = ElapsedMicroseconds(flushStart);

    const auto replaceStart = std::chrono::steady_clock::now();
    if (!AtomicRenameReplace(replacement.get(), canonicalDestination, error)) {
        AtomicResult("ERROR|" + std::to_string(error) + "|publish|0", error);
        return 0;
    }
    const std::uint64_t replaceUs = ElapsedMicroseconds(replaceStart);

    const auto verificationStart = std::chrono::steady_clock::now();
    std::wstring finalHash;
    if (!Sha256(replacement.get(), finalHash, error) || !SameOrdinal(finalHash, expectedNewHash)) {
        if (error == ERROR_SUCCESS) error = ERROR_INVALID_DATA;
        AtomicResult("ERROR|" + std::to_string(error) + "|post-verification|1", error);
        return 0;
    }
    std::string finalHashAscii;
    if (!ToAscii(finalHash, finalHashAscii)) finalHashAscii = std::string(64, '0');
    AtomicResult("OK|" + finalHashAscii + "|" + std::to_string(flushUs) + "|" +
        std::to_string(replaceUs) + "|" + std::to_string(ElapsedMicroseconds(verificationStart)), error);
    return 0;
}

} // namespace

int wmain(int argc, wchar_t** argv) {
    HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
    HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
    if (argc == 2 && argv != nullptr &&
        CompareStringOrdinal(argv[1], -1, L"--cleanup-temp", -1, FALSE) == CSTR_EQUAL) {
        if (input == nullptr || input == INVALID_HANDLE_VALUE) return 1;
        return RunTempCleanup(input);
    }
    if (argc == 5 && argv != nullptr &&
        CompareStringOrdinal(argv[1], -1, L"--durable-atomic-publish", -1, FALSE) == CSTR_EQUAL) {
        return RunDurableAtomicPublish(argv[2], argv[3], argv[4]);
    }
    if (argc == 8 && argv != nullptr &&
        CompareStringOrdinal(argv[1], -1, L"--atomic-replace", -1, FALSE) == CSTR_EQUAL) {
        return RunAtomicReplace(argv[2], argv[3], argv[4], argv[5], argv[6], argv[7]);
    }
    if (output == nullptr || output == INVALID_HANDLE_VALUE) {
        return 2;
    }

    DWORD error = ERROR_SUCCESS;
    if (!WriteHeader(output, error)) {
        return 2;
    }
    if (argc != 1) {
        EmitResult(output, Outcome::HelperError, 0, ERROR_INVALID_PARAMETER);
        return 0;
    }
    if (input == nullptr || input == INVALID_HANDLE_VALUE) {
        EmitResult(output, Outcome::HelperError, 0, ERROR_INVALID_HANDLE);
        return 0;
    }

    Request request;
    if (!ReadRequest(input, request, error)) {
        EmitResult(output, Outcome::HelperError, 0,
                   error == ERROR_SUCCESS ? ERROR_INVALID_DATA : error);
        return 0;
    }
    ControlReader control(input);
    if (!control.Start()) {
        EmitResult(output, Outcome::HelperError, 0, ERROR_NOT_ENOUGH_MEMORY);
        return 0;
    }

    const auto deadline = std::chrono::steady_clock::now() +
                          std::chrono::seconds(request.timeoutSeconds);
    Outcome outcome = Outcome::HelperError;
    DWORD childExitCode = 0;
    DWORD resultError = ERROR_SUCCESS;
    const char* failureStage = nullptr;
    UniqueHandle job;
    UniqueHandle stdoutRead;
    UniqueHandle stdoutWrite;
    UniqueHandle stderrRead;
    UniqueHandle stderrWrite;
    UniqueHandle nullInput;
    UniqueHandle process;
    UniqueHandle primaryThread;
    std::vector<UniqueHandle> materialLocks;
    std::thread stdoutPump;
    std::thread stderrPump;
    bool processCreated = false;
    bool verifiedInJob = false;
    bool jobZeroConfirmed = true;
    ChildEnvironment environment;

    const ControlEvent initialControl = control.state();
    if (initialControl != ControlEvent::None) {
        outcome = OutcomeFromControl(initialControl);
        if (initialControl != ControlEvent::Cancel) {
            resultError = ERROR_INVALID_DATA;
        }
    } else if (request.recipe == 2 && !EnsureCurrentTokenNotElevated(resultError)) {
        failureStage = "reject-elevated-token";
        outcome = Outcome::HelperError;
    } else if (!ValidateRequestPaths(request, resultError)) {
        failureStage = "validate-paths";
        outcome = Outcome::HelperError;
    } else if (!LockExecutionMaterials(request, materialLocks, resultError)) {
        failureStage = "lock-execution-materials";
        outcome = Outcome::HelperError;
    } else if (!BuildEnvironment(request, environment, resultError)) {
        failureStage = "build-environment";
        outcome = Outcome::HelperError;
    } else if (control.state() != ControlEvent::None) {
        const ControlEvent event = control.state();
        outcome = OutcomeFromControl(event);
        if (event != ControlEvent::Cancel) {
            resultError = event == ControlEvent::OwnerLost ? ERROR_BROKEN_PIPE : ERROR_INVALID_DATA;
        }
    } else if (!CreateJob(job, resultError)) {
        failureStage = "create-job";
        outcome = Outcome::HelperError;
    } else if (!CreateSuspendedChild(request, environment, job.get(),
                                     stdoutRead, stdoutWrite, stderrRead,
                                     stderrWrite, nullInput, process,
                                     primaryThread, resultError)) {
        failureStage = "create-suspended-child";
        outcome = Outcome::HelperError;
    } else {
        processCreated = true;
        nullInput.reset();
        stdoutWrite.reset();
        stderrWrite.reset();

        auto terminateTree = [&](DWORD terminationCode) {
            if (!TerminateJobObject(job.get(), terminationCode)) {
                const DWORD terminateError = GetLastError();
                if (terminateError != ERROR_ACCESS_DENIED) {
                    SetFirstError(terminateError, resultError);
                }
            }
            DWORD waitError = ERROR_SUCCESS;
            const bool confirmed = WaitForJobZero(job.get(), process.get(), waitError);
            if (!confirmed) {
                SetFirstError(waitError, resultError);
            }
            return confirmed;
        };

        if (!VerifyChildInJob(process.get(), job.get(), resultError)) {
            failureStage = "verify-child-in-job";
            // Do not resume unless the atomic JOB_LIST assignment is verified.
            jobZeroConfirmed = terminateTree(ERROR_PROCESS_ABORTED);
            if (!jobZeroConfirmed) {
                DWORD cleanupError = ERROR_SUCCESS;
                if (TerminateUnverifiedSuspendedProcess(process.get(), cleanupError)) {
                    DWORD waitError = ERROR_SUCCESS;
                    jobZeroConfirmed = WaitForJobZero(job.get(), process.get(), waitError);
                    if (!jobZeroConfirmed) {
                        SetFirstError(waitError, resultError);
                    }
                } else {
                    SetFirstError(cleanupError, resultError);
                }
            }
            outcome = Outcome::HelperError;
        } else {
            verifiedInJob = true;
            const bool testReleased = TestWaitBeforeResume(L"suspended", GetProcessId(process.get()), resultError);
            ControlEvent event = control.state();
            if (!testReleased || event != ControlEvent::None || std::chrono::steady_clock::now() >= deadline) {
                if (event == ControlEvent::Cancel) {
                    outcome = Outcome::Cancelled;
                } else if (event == ControlEvent::None) {
                    outcome = Outcome::TimedOut;
                } else {
                    outcome = Outcome::HelperError;
                    resultError = event == ControlEvent::OwnerLost
                                      ? ERROR_BROKEN_PIPE
                                      : ERROR_INVALID_DATA;
                }
                const DWORD terminationCode = outcome == Outcome::TimedOut
                                                  ? ERROR_TIMEOUT
                                                  : ERROR_CANCELLED;
                jobZeroConfirmed = terminateTree(terminationCode);
                if (jobZeroConfirmed) {
                    childExitCode = GetChildExitCode(process.get());
                } else {
                    outcome = Outcome::HelperError;
                }
            } else {
                try {
                    stdoutPump = std::thread(PumpOutput, stdoutRead.get(), output, kFrameStdout);
                    stderrPump = std::thread(PumpOutput, stderrRead.get(), output, kFrameStderr);
                } catch (...) {
                    resultError = ERROR_NOT_ENOUGH_MEMORY;
                    jobZeroConfirmed = terminateTree(ERROR_PROCESS_ABORTED);
                    outcome = Outcome::HelperError;
                }

                if (stdoutPump.joinable() && stderrPump.joinable()) {
                    event = control.state();
                    if (event != ControlEvent::None ||
                        std::chrono::steady_clock::now() >= deadline) {
                        if (event == ControlEvent::Cancel) {
                            outcome = Outcome::Cancelled;
                        } else if (event == ControlEvent::None) {
                            outcome = Outcome::TimedOut;
                        } else {
                            outcome = Outcome::HelperError;
                            resultError = event == ControlEvent::OwnerLost
                                              ? ERROR_BROKEN_PIPE
                                              : ERROR_INVALID_DATA;
                        }
                        const DWORD terminationCode = outcome == Outcome::TimedOut
                                                          ? ERROR_TIMEOUT
                                                          : ERROR_CANCELLED;
                        jobZeroConfirmed = terminateTree(terminationCode);
                        if (jobZeroConfirmed) {
                            childExitCode = GetChildExitCode(process.get());
                        } else {
                            outcome = Outcome::HelperError;
                        }
                    } else {
                        const bool materialLocksVerified = request.recipe == 3 ||
                            VerifyRuntimeMaterialLocks(request, resultError);
                        if (!materialLocksVerified) failureStage = "verify-runtime-material-locks";
                        UniqueHandle launchPermit;
                        PermissionLaunchPermit fullAccessLaunchPermit;
                        std::vector<UniqueHandle> snapshotChecks;
                        bool snapshotsVerified = true;
                        for (const auto& material : request.launchSnapshots) {
                            if (!OpenFileLock(material.path, &material.fileIdentity, &material.hash, snapshotChecks, resultError)) { snapshotsVerified = false; break; }
                        }
                        const bool launchAuthorized = materialLocksVerified && snapshotsVerified &&
                            AcquireLaunchPermit(request, launchPermit, fullAccessLaunchPermit, resultError) &&
                            TestWaitBeforeResume(L"permit", GetProcessId(process.get()), resultError);
                        if (materialLocksVerified && !launchAuthorized) failureStage = "launch-permit";
                        // Git itself must update these files; release just before
                        // Resume. Commit uses pinned tree/parent + ref CAS as well.
                        snapshotChecks.clear();
                        const ControlEvent beforeResumeEvent = control.state();
                        const auto beforeResumeTime = std::chrono::steady_clock::now();
                        const bool resumeAuthorized = launchAuthorized &&
                            beforeResumeEvent == ControlEvent::None && beforeResumeTime < deadline;
                        const DWORD previousSuspendCount = resumeAuthorized
                            ? ResumeThread(primaryThread.get())
                            : static_cast<DWORD>(-1);
                        launchPermit.reset();
                        fullAccessLaunchPermit.reset();
                        if (previousSuspendCount != 1) {
                            if (resumeAuthorized) {
                                resultError = previousSuspendCount == static_cast<DWORD>(-1)
                                                  ? GetLastError()
                                                  : ERROR_INVALID_STATE;
                                failureStage = "resume-child";
                            }
                            jobZeroConfirmed = terminateTree(ERROR_PROCESS_ABORTED);
                            if (!jobZeroConfirmed) {
                                outcome = Outcome::HelperError;
                            } else if (beforeResumeEvent == ControlEvent::Cancel) {
                                outcome = Outcome::Cancelled;
                            } else if (beforeResumeEvent == ControlEvent::None && beforeResumeTime >= deadline) {
                                outcome = Outcome::TimedOut;
                            } else if (materialLocksVerified && !launchAuthorized) {
                                outcome = snapshotsVerified ? Outcome::AuthorizationDenied : Outcome::PrelaunchStateChanged;
                            } else {
                                outcome = Outcome::HelperError;
                                if (beforeResumeEvent == ControlEvent::OwnerLost) resultError = ERROR_BROKEN_PIPE;
                                else if (resultError == ERROR_SUCCESS) resultError = ERROR_INVALID_DATA;
                            }
                        } else {
                            primaryThread.reset();
                            bool terminateIssued = false;
                            Outcome forcedOutcome = Outcome::HelperError;
                            DWORD terminationCode = ERROR_PROCESS_ABORTED;
                            auto drainDeadline = std::chrono::steady_clock::time_point::max();

                            for (;;) {
                                event = control.state();
                                const DWORD outputError = g_outputError.load();
                                const auto now = std::chrono::steady_clock::now();

                                if (!terminateIssued) {
                                    if (event == ControlEvent::Cancel) {
                                        forcedOutcome = Outcome::Cancelled;
                                        terminationCode = ERROR_CANCELLED;
                                    } else if (event == ControlEvent::OwnerLost ||
                                               event == ControlEvent::ProtocolError) {
                                        forcedOutcome = Outcome::HelperError;
                                        resultError = event == ControlEvent::OwnerLost
                                                          ? ERROR_BROKEN_PIPE
                                                          : ERROR_INVALID_DATA;
                                    } else if (outputError != ERROR_SUCCESS) {
                                        forcedOutcome = Outcome::HelperError;
                                        resultError = outputError;
                                    } else if (now >= deadline) {
                                        forcedOutcome = Outcome::TimedOut;
                                        terminationCode = ERROR_TIMEOUT;
                                    }

                                    if (event != ControlEvent::None ||
                                        outputError != ERROR_SUCCESS || now >= deadline) {
                                        terminateIssued = true;
                                        drainDeadline = now +
                                            std::chrono::milliseconds(kJobDrainLimitMs);
                                        if (!TerminateJobObject(job.get(), terminationCode)) {
                                            const DWORD terminateError = GetLastError();
                                            if (terminateError != ERROR_ACCESS_DENIED) {
                                                SetFirstError(terminateError, resultError);
                                                forcedOutcome = Outcome::HelperError;
                                            }
                                        }
                                    }
                                }

                                DWORD active = 0;
                                DWORD queryError = ERROR_SUCCESS;
                                if (!QueryActiveProcesses(job.get(), active, queryError)) {
                                    if (!terminateIssued) {
                                        terminateIssued = true;
                                        forcedOutcome = Outcome::HelperError;
                                        resultError = queryError;
                                        drainDeadline = now +
                                            std::chrono::milliseconds(kJobDrainLimitMs);
                                        TerminateJobObject(job.get(), ERROR_PROCESS_ABORTED);
                                    } else {
                                        SetFirstError(queryError, resultError);
                                    }
                                    if (std::chrono::steady_clock::now() >= drainDeadline) {
                                        jobZeroConfirmed = false;
                                        outcome = Outcome::HelperError;
                                        SetFirstError(queryError, resultError);
                                        break;
                                    }
                                    Sleep(10);
                                    continue;
                                }

                                if (active == 0) {
                                    const DWORD rootWait = WaitForSingleObject(
                                        process.get(), kJobDrainLimitMs);
                                    if (rootWait == WAIT_OBJECT_0) {
                                        jobZeroConfirmed = true;
                                        outcome = terminateIssued
                                                      ? forcedOutcome
                                                      : Outcome::Completed;
                                        childExitCode = GetChildExitCode(process.get());
                                    } else {
                                        jobZeroConfirmed = false;
                                        outcome = Outcome::HelperError;
                                        SetFirstError(rootWait == WAIT_FAILED
                                                          ? GetLastError()
                                                          : ERROR_TIMEOUT,
                                                      resultError);
                                    }
                                    break;
                                }

                                if (terminateIssued && std::chrono::steady_clock::now() >= drainDeadline) {
                                    jobZeroConfirmed = false;
                                    outcome = Outcome::HelperError;
                                    SetFirstError(ERROR_TIMEOUT, resultError);
                                    break;
                                }
                                Sleep(10);
                            }
                        }
                    }
                }
            }
        }
    }

    if (processCreated && job.valid() && !jobZeroConfirmed) {
        // Closing KILL_ON_JOB_CLOSE is the fail-closed cleanup if confirmation
        // itself failed. Normal terminal results are emitted only after zero.
        job.reset();
    }
    if (processCreated && verifiedInJob) {
        if (stdoutPump.joinable()) {
            if (jobZeroConfirmed) {
                stdoutPump.join();
            } else {
                StopPump(stdoutPump, stdoutRead.get());
                stdoutRead.release();
            }
        }
        if (stderrPump.joinable()) {
            if (jobZeroConfirmed) {
                stderrPump.join();
            } else {
                StopPump(stderrPump, stderrRead.get());
                stderrRead.release();
            }
        }
    }

    control.WaitForEvent(100);
    const ControlEvent finalControl = control.state();
    if (finalControl == ControlEvent::ProtocolError || finalControl == ControlEvent::OwnerLost) {
        outcome = Outcome::HelperError;
        if (resultError == ERROR_SUCCESS) {
            resultError = finalControl == ControlEvent::OwnerLost
                              ? ERROR_BROKEN_PIPE
                              : ERROR_INVALID_DATA;
        }
    } else if (finalControl == ControlEvent::Cancel && outcome == Outcome::Completed) {
        outcome = Outcome::Cancelled;
        resultError = ERROR_SUCCESS;
    }

    if (outcome == Outcome::Completed) {
        resultError = ERROR_SUCCESS;
    } else if (resultError == ERROR_SUCCESS && outcome == Outcome::HelperError) {
        resultError = ERROR_GEN_FAILURE;
    }
    if (outcome == Outcome::HelperError) WriteHelperFailureDiagnostic(failureStage, resultError);
    const bool resultEmitted = EmitResult(output, outcome, childExitCode, resultError);
    if (!resultEmitted) {
        // This one-shot helper must exit even when the owner has already
        // closed its output channel. The OS closes the Job handle on exit.
        ExitProcess(2);
        return 2;
    }
    // The control reader may still be blocked in a synchronous stdin read
    // while the owner keeps the pipe open. All child work has already been
    // confirmed empty (or the Job was closed fail-closed above), so process
    // exit safely releases that reader and every remaining handle.
    ExitProcess(0);
    return 0;
}
