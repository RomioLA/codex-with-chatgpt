#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#include <windows.h>
#include <bcrypt.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cwchar>
#include <iterator>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace {

constexpr DWORD kMaxFieldBytes = 131072;
constexpr DWORD kMaxTargetBytes = 64;
constexpr DWORD kMaxFrameBytes = 64 * 1024;
constexpr DWORD kJobDrainLimitMs = 30000;
constexpr DWORD kNoChildExitCode = 0xFFFFFFFFu;

constexpr BYTE kOutcomeCompleted = 0;
constexpr BYTE kOutcomeCancelled = 1;
constexpr BYTE kOutcomeTimedOut = 2;
constexpr BYTE kOutcomeHelperError = 3;

constexpr BYTE kFrameStdout = 1;
constexpr BYTE kFrameStderr = 2;
constexpr BYTE kFrameResult = 3;

constexpr BYTE kRequestMagic[8] = {'C', '2', 'C', 'J', 'O', 'B', '5', 0};
constexpr BYTE kOutputMagic[8] = {'C', '2', 'C', 'O', 'U', 'T', '5', 0};
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

struct Request {
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

bool Utf8ToWide(const std::string& input, std::wstring& output) {
    if (input.empty() || input.find('\0') != std::string::npos ||
        input.size() > static_cast<size_t>(kMaxFieldBytes)) {
        return false;
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

bool ReadString(HANDLE input, DWORD maximumBytes, std::wstring& output, DWORD& error) {
    DWORD length = 0;
    if (!ReadU32(input, length, error)) {
        return false;
    }
    if (length == 0 || length > maximumBytes || length > kMaxFieldBytes) {
        error = ERROR_INVALID_DATA;
        return false;
    }

    std::string bytes(static_cast<size_t>(length), '\0');
    if (!ReadExact(input, bytes.data(), length, error)) {
        return false;
    }
    if (!Utf8ToWide(bytes, output)) {
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
    if (!std::equal(std::begin(magic), std::end(magic), std::begin(kRequestMagic))) {
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

    if (version != 5 || recipe != 1 || reservedByte != 0 || reservedWord != 0 ||
        (request.manager != 1 && request.manager != 2) ||
        request.kind < 1 || request.kind > 5 ||
        request.timeoutSeconds < 1 || request.timeoutSeconds > 3600) {
        error = ERROR_INVALID_DATA;
        return false;
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

bool ValidateRequestPaths(Request& request, DWORD& error) {
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
    if (!LockDirectoryPath(request.cwd, &request.repositoryFileIdentity, locks, error) ||
        !LockDirectoryPath(request.gitDirectory, &request.gitDirectoryFileIdentity, locks, error) ||
        !LockDirectoryPath(request.commonGitDirectory, &request.commonGitDirectoryFileIdentity, locks, error) ||
        !LockDirectoryPath(request.tempRootPath, &request.tempRootFileIdentity, locks, error) ||
        !LockDirectoryPath(request.jobTempDir, &request.jobTempFileIdentity, locks, error)) {
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

    const std::wstring manifestPath = request.cwd + L"\\package.json";
    if (!OpenFileLock(manifestPath, nullptr, &request.packageJsonHash, locks, error)) return false;

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
    environment.path = environment.system32 + L";" + nodeDirectory;
    environment.systemRoot = windowsDir;

    std::vector<std::pair<std::wstring, std::wstring>> entries = {
        {L"SystemRoot", environment.systemRoot},
        {L"WINDIR", environment.systemRoot},
        {L"ComSpec", environment.comSpec},
        {L"PATH", environment.path},
        {L"TEMP", environment.privateTemp},
        {L"TMP", environment.privateTemp},
        {L"USERPROFILE", environment.privateTemp},
        {L"APPDATA", environment.privateTemp},
        {L"LOCALAPPDATA", environment.privateTemp},
        {L"PATHEXT", L".COM;.EXE;.BAT;.CMD"},
        {L"npm_config_userconfig", environment.userConfig},
        {L"npm_config_globalconfig", environment.globalConfig},
        {L"npm_config_cache", environment.npmCache},
        {L"npm_config_script_shell", environment.comSpec},
        {L"GIT_CONFIG_GLOBAL", environment.gitConfig},
        {L"GIT_CONFIG_SYSTEM", environment.gitConfig},
        {L"GIT_CONFIG_NOSYSTEM", L"1"},
        {L"GIT_CONFIG_COUNT", L"2"},
        {L"GIT_CONFIG_KEY_0", L"core.hooksPath"},
        {L"GIT_CONFIG_VALUE_0", environment.gitHooksDir},
        {L"GIT_CONFIG_KEY_1", L"credential.helper"},
        {L"GIT_CONFIG_VALUE_1", L""},
        {L"GIT_TERMINAL_PROMPT", L"0"},
    };
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
    if (!CreateProcessW(request.nodeExecutable.c_str(), commandLine.data(),
                        nullptr, nullptr, TRUE, creationFlags,
                        const_cast<wchar_t*>(environment.block.data()), request.cwd.c_str(),
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

} // namespace

int wmain(int argc, wchar_t** argv) {
    HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
    HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
    if (argc == 2 && argv != nullptr &&
        CompareStringOrdinal(argv[1], -1, L"--cleanup-temp", -1, FALSE) == CSTR_EQUAL) {
        if (input == nullptr || input == INVALID_HANDLE_VALUE) return 1;
        return RunTempCleanup(input);
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
            ControlEvent event = control.state();
            if (event != ControlEvent::None || std::chrono::steady_clock::now() >= deadline) {
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
                        const bool materialLocksVerified =
                            VerifyRuntimeMaterialLocks(request, resultError);
                        if (!materialLocksVerified) failureStage = "verify-runtime-material-locks";
                        const DWORD previousSuspendCount = materialLocksVerified
                            ? ResumeThread(primaryThread.get())
                            : static_cast<DWORD>(-1);
                        if (previousSuspendCount != 1) {
                            if (materialLocksVerified) {
                                resultError = previousSuspendCount == static_cast<DWORD>(-1)
                                                  ? GetLastError()
                                                  : ERROR_INVALID_STATE;
                                failureStage = "resume-child";
                            }
                            jobZeroConfirmed = terminateTree(ERROR_PROCESS_ABORTED);
                            outcome = Outcome::HelperError;
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
