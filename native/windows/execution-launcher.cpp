#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#include <windows.h>
#include <bcrypt.h>

#include <algorithm>
#include <cstdint>
#include <string>
#include <utility>
#include <vector>

namespace {

constexpr BYTE kExecutionMagic[8] = {'C', '2', 'C', 'J', 'O', 'B', '5', 0};
constexpr BYTE kCleanupMagic[8] = {'C', '2', 'C', 'T', 'M', 'P', '1', 0};
constexpr wchar_t kHelperName[] = L"c2c-execution-helper.exe";
constexpr wchar_t kLauncherName[] = L"c2c-execution-launcher.exe";
constexpr wchar_t kMetadataRelative[] = L"..\\..\\dist\\execution\\c2c-execution-helper-integrity.json";
constexpr char kMetadataPrefix[] =
    "{\"version\":2,\"protocolVersion\":5,\"helperPath\":\"build/native/c2c-execution-helper.exe\",\"sha256\":\"";
constexpr char kMetadataMiddle[] =
    "\",\"launcherPath\":\"build/native/c2c-execution-launcher.exe\",\"launcherSha256\":\"";

struct UniqueHandle {
    HANDLE value = INVALID_HANDLE_VALUE;

    UniqueHandle() = default;
    explicit UniqueHandle(HANDLE handle) : value(handle) {}
    UniqueHandle(const UniqueHandle&) = delete;
    UniqueHandle& operator=(const UniqueHandle&) = delete;
    UniqueHandle(UniqueHandle&& other) noexcept : value(other.release()) {}
    UniqueHandle& operator=(UniqueHandle&& other) noexcept {
        if (this != &other) reset(other.release());
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
    void reset(HANDLE handle = INVALID_HANDLE_VALUE) {
        if (valid()) CloseHandle(value);
        value = handle;
    }
};

bool SameOrdinal(const std::wstring& left, const std::wstring& right) {
    return CompareStringOrdinal(left.c_str(), -1, right.c_str(), -1, TRUE) == CSTR_EQUAL;
}

std::wstring StripExtendedPrefix(std::wstring value) {
    if (value.rfind(L"\\\\?\\UNC\\", 0) == 0) return L"\\\\" + value.substr(8);
    if (value.rfind(L"\\\\?\\", 0) == 0) return value.substr(4);
    return value;
}

bool IsDriveAbsolutePath(const std::wstring& value) {
    return value.size() >= 3 &&
        ((value[0] >= L'A' && value[0] <= L'Z') || (value[0] >= L'a' && value[0] <= L'z')) &&
        value[1] == L':' && value[2] == L'\\';
}

std::wstring ParentDirectory(const std::wstring& value) {
    const size_t separator = value.find_last_of(L'\\');
    if (separator == 2) return value.substr(0, 3);
    if (separator == std::wstring::npos) return {};
    return value.substr(0, separator);
}

bool GetFullPath(const std::wstring& input, std::wstring& output, DWORD& error) {
    DWORD required = GetFullPathNameW(input.c_str(), 0, nullptr, nullptr);
    if (required == 0 || required > 32768) {
        error = GetLastError();
        if (error == ERROR_SUCCESS) error = ERROR_INVALID_NAME;
        return false;
    }
    std::vector<wchar_t> buffer(static_cast<size_t>(required) + 1);
    DWORD written = GetFullPathNameW(input.c_str(), static_cast<DWORD>(buffer.size()), buffer.data(), nullptr);
    if (written == 0 || written >= buffer.size()) {
        error = GetLastError();
        if (error == ERROR_SUCCESS) error = ERROR_INSUFFICIENT_BUFFER;
        return false;
    }
    output.assign(buffer.data(), written);
    output = StripExtendedPrefix(std::move(output));
    if (!IsDriveAbsolutePath(output)) {
        error = ERROR_INVALID_NAME;
        return false;
    }
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

bool LockDirectoryPath(const std::wstring& path, std::vector<UniqueHandle>& locks, DWORD& error) {
    if (!IsDriveAbsolutePath(path)) {
        error = ERROR_INVALID_NAME;
        return false;
    }
    std::wstring componentPath = path.substr(0, 3);
    size_t cursor = 3;
    for (;;) {
        UniqueHandle handle(CreateFileW(componentPath.c_str(), FILE_READ_ATTRIBUTES,
                                        FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                                        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                                        nullptr));
        if (!handle.valid()) {
            error = GetLastError();
            return false;
        }
        if (!DirectoryAttributes(handle.get(), error)) return false;
        locks.push_back(std::move(handle));

        if (cursor >= path.size()) break;
        const size_t separator = path.find(L'\\', cursor);
        const size_t end = separator == std::wstring::npos ? path.size() : separator;
        componentPath += path.substr(cursor, end - cursor);
        if (end == path.size()) cursor = path.size();
        else {
            componentPath.push_back(L'\\');
            cursor = end + 1;
        }
    }
    return true;
}

bool OpenRegularFileLock(const std::wstring& path, UniqueHandle& handle, DWORD& error) {
    handle.reset(CreateFileW(path.c_str(), GENERIC_READ | FILE_READ_ATTRIBUTES,
                             FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                             FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    if (!handle.valid()) {
        error = GetLastError();
        return false;
    }
    FILE_ATTRIBUTE_TAG_INFO info{};
    if (!GetFileInformationByHandleEx(handle.get(), FileAttributeTagInfo, &info, sizeof(info))) {
        error = GetLastError();
        return false;
    }
    if ((info.FileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0 ||
        GetFileType(handle.get()) != FILE_TYPE_DISK) {
        error = ERROR_INVALID_DATA;
        return false;
    }
    return true;
}

bool GetFinalPath(HANDLE handle, std::wstring& path, DWORD& error) {
    DWORD required = GetFinalPathNameByHandleW(handle, nullptr, 0, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    if (required == 0 || required > 32768) {
        error = GetLastError();
        if (error == ERROR_SUCCESS) error = ERROR_INVALID_NAME;
        return false;
    }
    std::vector<wchar_t> buffer(static_cast<size_t>(required) + 1);
    DWORD written = GetFinalPathNameByHandleW(handle, buffer.data(), static_cast<DWORD>(buffer.size()),
                                               FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    if (written == 0 || written >= buffer.size()) {
        error = GetLastError();
        if (error == ERROR_SUCCESS) error = ERROR_INSUFFICIENT_BUFFER;
        return false;
    }
    path.assign(buffer.data(), written);
    path = StripExtendedPrefix(std::move(path));
    return true;
}

bool FileIdentity(HANDLE handle, std::wstring& identity, DWORD& error) {
    BY_HANDLE_FILE_INFORMATION info{};
    if (!GetFileInformationByHandle(handle, &info)) {
        error = GetLastError();
        return false;
    }
    const std::uint64_t index =
        (static_cast<std::uint64_t>(info.nFileIndexHigh) << 32) | info.nFileIndexLow;
    wchar_t buffer[64]{};
    if (swprintf_s(buffer, L"%lx:%llx", info.dwVolumeSerialNumber,
                   static_cast<unsigned long long>(index)) <= 0) {
        error = ERROR_INVALID_DATA;
        return false;
    }
    identity.assign(buffer);
    return true;
}

bool Sha256(HANDLE file, std::string& hex, DWORD& error) {
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
    static constexpr char digits[] = "0123456789abcdef";
    hex.clear();
    hex.reserve(64);
    for (BYTE byte : digest) {
        hex.push_back(digits[byte >> 4]);
        hex.push_back(digits[byte & 0x0f]);
    }
    return true;
}

bool IsLowerHexSha256(const std::string& value) {
    return value.size() == 64 && std::all_of(value.begin(), value.end(), [](char ch) {
        return (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f');
    });
}

bool ReadMetadataHashes(HANDLE metadata, std::string& helperHash, std::string& launcherHash,
                        DWORD& error) {
    LARGE_INTEGER size{};
    if (!GetFileSizeEx(metadata, &size) || size.QuadPart < 1 || size.QuadPart > 2048) {
        error = GetLastError();
        if (error == ERROR_SUCCESS) error = ERROR_INVALID_DATA;
        return false;
    }
    LARGE_INTEGER beginning{};
    if (!SetFilePointerEx(metadata, beginning, nullptr, FILE_BEGIN)) {
        error = GetLastError();
        return false;
    }
    std::string contents(static_cast<size_t>(size.QuadPart), '\0');
    DWORD received = 0;
    if (!ReadFile(metadata, contents.data(), static_cast<DWORD>(contents.size()), &received, nullptr) ||
        received != contents.size()) {
        error = GetLastError();
        if (error == ERROR_SUCCESS) error = ERROR_INVALID_DATA;
        return false;
    }
    const size_t prefixLength = sizeof(kMetadataPrefix) - 1;
    const size_t middleLength = sizeof(kMetadataMiddle) - 1;
    if (contents.size() != prefixLength + 64 + middleLength + 64 + 2 ||
        contents.compare(0, prefixLength, kMetadataPrefix) != 0) {
        error = ERROR_INVALID_DATA;
        return false;
    }
    const size_t middleOffset = prefixLength + 64;
    if (contents.compare(middleOffset, middleLength, kMetadataMiddle) != 0 ||
        contents.back() != '}') {
        error = ERROR_INVALID_DATA;
        return false;
    }
    helperHash = contents.substr(prefixLength, 64);
    launcherHash = contents.substr(middleOffset + middleLength, 64);
    if (!IsLowerHexSha256(helperHash) || !IsLowerHexSha256(launcherHash)) {
        error = ERROR_INVALID_DATA;
        return false;
    }
    return true;
}

bool ValidatePeImage(HANDLE file, DWORD& error) {
    LARGE_INTEGER size{};
    if (!GetFileSizeEx(file, &size) || size.QuadPart < 0x100 || size.QuadPart > 0x7fffffff) {
        error = ERROR_BAD_EXE_FORMAT;
        return false;
    }
    LARGE_INTEGER zero{};
    if (!SetFilePointerEx(file, zero, nullptr, FILE_BEGIN)) {
        error = GetLastError();
        return false;
    }
    BYTE dos[64]{};
    DWORD received = 0;
    if (!ReadFile(file, dos, sizeof(dos), &received, nullptr) || received != sizeof(dos) ||
        dos[0] != 'M' || dos[1] != 'Z') {
        error = ERROR_BAD_EXE_FORMAT;
        return false;
    }
    const DWORD peOffset = *reinterpret_cast<const DWORD*>(dos + 0x3c);
    if (peOffset > static_cast<DWORD>(size.QuadPart) - 6) {
        error = ERROR_BAD_EXE_FORMAT;
        return false;
    }
    LARGE_INTEGER offset{};
    offset.QuadPart = peOffset;
    if (!SetFilePointerEx(file, offset, nullptr, FILE_BEGIN)) {
        error = GetLastError();
        return false;
    }
    BYTE header[6]{};
    if (!ReadFile(file, header, sizeof(header), &received, nullptr) || received != sizeof(header) ||
        header[0] != 'P' || header[1] != 'E' || header[2] != 0 || header[3] != 0 ||
        (static_cast<WORD>(header[4]) | (static_cast<WORD>(header[5]) << 8)) != IMAGE_FILE_MACHINE_AMD64) {
        error = ERROR_BAD_EXE_FORMAT;
        return false;
    }
    return true;
}

bool GetModulePath(std::wstring& path, DWORD& error) {
    std::vector<wchar_t> buffer(32768);
    DWORD written = GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
    if (written == 0 || written >= buffer.size()) {
        error = GetLastError();
        if (error == ERROR_SUCCESS) error = ERROR_INSUFFICIENT_BUFFER;
        return false;
    }
    return GetFullPath(std::wstring(buffer.data(), written), path, error);
}

bool PeekProtocolMode(HANDLE input, bool& cleanupMode, DWORD& error) {
    for (unsigned attempt = 0; attempt < 30000; ++attempt) {
        BYTE prefix[8]{};
        DWORD received = 0;
        DWORD available = 0;
        if (!PeekNamedPipe(input, prefix, sizeof(prefix), &received, &available, nullptr)) {
            error = GetLastError();
            return false;
        }
        if (received >= sizeof(prefix)) {
            if (std::equal(std::begin(prefix), std::end(prefix), std::begin(kExecutionMagic))) {
                cleanupMode = false;
                return true;
            }
            if (std::equal(std::begin(prefix), std::end(prefix), std::begin(kCleanupMagic))) {
                cleanupMode = true;
                return true;
            }
            error = ERROR_INVALID_DATA;
            return false;
        }
        if (available >= sizeof(prefix)) {
            Sleep(1);
            continue;
        }
        Sleep(1);
    }
    error = WAIT_TIMEOUT;
    return false;
}

bool DuplicateInheritable(HANDLE source, UniqueHandle& duplicate, DWORD& error) {
    if (source == nullptr || source == INVALID_HANDLE_VALUE) {
        error = ERROR_INVALID_HANDLE;
        return false;
    }
    HANDLE copy = nullptr;
    if (!DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), &copy,
                         0, TRUE, DUPLICATE_SAME_ACCESS)) {
        error = GetLastError();
        return false;
    }
    duplicate.reset(copy);
    return true;
}

bool CreateHelperProcess(const std::wstring& helperPath, bool cleanupMode,
                         HANDLE input, HANDLE output, HANDLE errorOutput,
                         UniqueHandle& process, DWORD& error) {
    UniqueHandle childInput;
    UniqueHandle childOutput;
    UniqueHandle childError;
    if (!DuplicateInheritable(input, childInput, error) ||
        !DuplicateInheritable(output, childOutput, error) ||
        !DuplicateInheritable(errorOutput, childError, error)) return false;

    SIZE_T attributeBytes = 0;
    InitializeProcThreadAttributeList(nullptr, 1, 0, &attributeBytes);
    std::vector<BYTE> attributeStorage(attributeBytes);
    auto* attributes = reinterpret_cast<PPROC_THREAD_ATTRIBUTE_LIST>(attributeStorage.data());
    if (!InitializeProcThreadAttributeList(attributes, 1, 0, &attributeBytes)) {
        error = GetLastError();
        return false;
    }
    struct AttributeListGuard {
        PPROC_THREAD_ATTRIBUTE_LIST list;
        ~AttributeListGuard() { if (list != nullptr) DeleteProcThreadAttributeList(list); }
    } guard{attributes};

    HANDLE inherited[] = { childInput.get(), childOutput.get(), childError.get() };
    if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                                   inherited, sizeof(inherited), nullptr, nullptr)) {
        error = GetLastError();
        return false;
    }
    STARTUPINFOEXW startup{};
    startup.StartupInfo.cb = sizeof(startup);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = childInput.get();
    startup.StartupInfo.hStdOutput = childOutput.get();
    startup.StartupInfo.hStdError = childError.get();
    startup.lpAttributeList = attributes;

    std::wstring commandLine = L"\"" + helperPath + L"\"";
    if (cleanupMode) commandLine += L" --cleanup-temp";
    std::vector<wchar_t> mutableCommandLine(commandLine.begin(), commandLine.end());
    mutableCommandLine.push_back(L'\0');
    PROCESS_INFORMATION processInfo{};
    const DWORD flags = EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW;
    if (!CreateProcessW(helperPath.c_str(), mutableCommandLine.data(), nullptr, nullptr, TRUE,
                        flags, nullptr, nullptr, &startup.StartupInfo, &processInfo)) {
        error = GetLastError();
        return false;
    }
    UniqueHandle primaryThread(processInfo.hThread);
    process.reset(processInfo.hProcess);
    return true;
}

bool TestEvidenceEnabled() {
    wchar_t value[2]{};
    DWORD length = GetEnvironmentVariableW(L"C2C_EXECUTION_LAUNCHER_TEST_EVIDENCE", value, 2);
    return length == 1 && value[0] == L'1';
}

void WriteEvidence(const std::wstring& line) {
    HANDLE output = GetStdHandle(STD_ERROR_HANDLE);
    if (output == nullptr || output == INVALID_HANDLE_VALUE) return;
    const std::string ascii(line.begin(), line.end());
    DWORD written = 0;
    WriteFile(output, ascii.data(), static_cast<DWORD>(ascii.size()), &written, nullptr);
}

void WriteFailure(const char* stage, DWORD error) {
    HANDLE output = GetStdHandle(STD_ERROR_HANDLE);
    if (output == nullptr || output == INVALID_HANDLE_VALUE) return;
    std::string message = "C2C_EXECUTION_LAUNCHER_FAILURE:" + std::string(stage) + ":" +
                         std::to_string(error) + "\n";
    DWORD written = 0;
    WriteFile(output, message.data(), static_cast<DWORD>(message.size()), &written, nullptr);
}

bool RunLauncher() {
    DWORD error = ERROR_SUCCESS;
    std::wstring modulePath;
    if (!GetModulePath(modulePath, error)) {
        WriteFailure("module-path", error);
        return false;
    }
    const std::wstring moduleDirectory = ParentDirectory(modulePath);
    std::wstring helperPath;
    std::wstring metadataPath;
    if (!GetFullPath(moduleDirectory + L"\\" + kHelperName, helperPath, error) ||
        !GetFullPath(moduleDirectory + L"\\" + kMetadataRelative, metadataPath, error)) {
        WriteFailure("expected-path", error);
        return false;
    }
    const std::wstring launcherPath = modulePath;
    if (CompareStringOrdinal(ParentDirectory(helperPath).c_str(), -1,
                             moduleDirectory.c_str(), -1, TRUE) != CSTR_EQUAL) {
        WriteFailure("helper-layout", ERROR_INVALID_NAME);
        return false;
    }

    std::vector<UniqueHandle> directoryLocks;
    if (!LockDirectoryPath(moduleDirectory, directoryLocks, error) ||
        !LockDirectoryPath(ParentDirectory(metadataPath), directoryLocks, error)) {
        WriteFailure("directory-lock", error);
        return false;
    }

    UniqueHandle metadata;
    if (!OpenRegularFileLock(metadataPath, metadata, error)) {
        WriteFailure("metadata-open", error);
        return false;
    }
    std::wstring metadataFinalPath;
    if (!GetFinalPath(metadata.get(), metadataFinalPath, error) || !SameOrdinal(metadataFinalPath, metadataPath)) {
        WriteFailure("metadata-path", error == ERROR_SUCCESS ? ERROR_REPARSE_TAG_INVALID : error);
        return false;
    }
    std::string expectedHelperHash;
    std::string expectedLauncherHash;
    if (!ReadMetadataHashes(metadata.get(), expectedHelperHash, expectedLauncherHash, error)) {
        WriteFailure("metadata-content", error);
        return false;
    }

    UniqueHandle launcher;
    if (!OpenRegularFileLock(launcherPath, launcher, error)) {
        WriteFailure("launcher-open", error);
        return false;
    }
    std::wstring launcherFinalPath;
    std::string launcherHash;
    if (!GetFinalPath(launcher.get(), launcherFinalPath, error) || !SameOrdinal(launcherFinalPath, launcherPath) ||
        !Sha256(launcher.get(), launcherHash, error) || launcherHash != expectedLauncherHash) {
        WriteFailure("launcher-integrity", error == ERROR_SUCCESS ? ERROR_INVALID_DATA : error);
        return false;
    }

    UniqueHandle helper;
    if (!OpenRegularFileLock(helperPath, helper, error)) {
        WriteFailure("helper-open", error);
        return false;
    }
    std::wstring helperFinalPath;
    std::string helperHash;
    std::wstring helperIdentity;
    if (!GetFinalPath(helper.get(), helperFinalPath, error) || !SameOrdinal(helperFinalPath, helperPath) ||
        !Sha256(helper.get(), helperHash, error) || helperHash != expectedHelperHash ||
        !ValidatePeImage(helper.get(), error) || !FileIdentity(helper.get(), helperIdentity, error)) {
        WriteFailure("helper-integrity", error == ERROR_SUCCESS ? ERROR_INVALID_DATA : error);
        return false;
    }

    const HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
    const HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
    const HANDLE errorOutput = GetStdHandle(STD_ERROR_HANDLE);
    if (input == nullptr || input == INVALID_HANDLE_VALUE || output == nullptr ||
        output == INVALID_HANDLE_VALUE || errorOutput == nullptr || errorOutput == INVALID_HANDLE_VALUE) {
        WriteFailure("stdio", ERROR_INVALID_HANDLE);
        return false;
    }
    bool cleanupMode = false;
    if (!PeekProtocolMode(input, cleanupMode, error)) {
        WriteFailure("protocol-mode", error);
        return false;
    }

    const bool evidence = TestEvidenceEnabled();
    if (evidence) {
        WriteEvidence(L"C2C_EXECUTION_LAUNCHER_EVIDENCE:LOCKED:" + helperIdentity + L":" +
                      std::wstring(helperHash.begin(), helperHash.end()) + L"\n");
        wchar_t hold[16]{};
        const DWORD length = GetEnvironmentVariableW(L"C2C_EXECUTION_LAUNCHER_TEST_HOLD_MS", hold, 16);
        if (length > 0 && length < 16) {
            wchar_t* end = nullptr;
            unsigned long value = wcstoul(hold, &end, 10);
            if (end != hold && *end == L'\0' && value <= 3000) Sleep(static_cast<DWORD>(value));
        }
    }

    UniqueHandle child;
    if (!CreateHelperProcess(helperPath, cleanupMode, input, output, errorOutput, child, error)) {
        WriteFailure("create-process", error);
        return false;
    }
    if (evidence) {
        DWORD processId = GetProcessId(child.get());
        wchar_t line[96]{};
        swprintf_s(line, L"C2C_EXECUTION_LAUNCHER_EVIDENCE:CREATED:%lu\n", processId);
        WriteEvidence(line);
    }

    DWORD wait = WaitForSingleObject(child.get(), INFINITE);
    if (wait != WAIT_OBJECT_0) {
        error = GetLastError();
        WriteFailure("wait-child", error);
        return false;
    }
    DWORD exitCode = 1;
    if (!GetExitCodeProcess(child.get(), &exitCode)) {
        error = GetLastError();
        WriteFailure("child-exit", error);
        return false;
    }
    return exitCode == 0;
}

} // namespace

int wmain(int argc, wchar_t**) {
    if (argc != 1) {
        WriteFailure("arguments", ERROR_INVALID_PARAMETER);
        return 1;
    }
    return RunLauncher() ? 0 : 1;
}
