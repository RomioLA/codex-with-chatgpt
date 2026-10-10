#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

int wmain() {
    HANDLE marker = CreateFileW(L"c2c-untrusted-helper-executed.marker", GENERIC_WRITE,
                                FILE_SHARE_READ, nullptr, CREATE_ALWAYS,
                                FILE_ATTRIBUTE_NORMAL, nullptr);
    if (marker == INVALID_HANDLE_VALUE) return 91;
    constexpr char message[] = "untrusted-helper-executed\n";
    DWORD written = 0;
    const BOOL result = WriteFile(marker, message, static_cast<DWORD>(sizeof(message) - 1),
                                  &written, nullptr);
    CloseHandle(marker);
    return result && written == sizeof(message) - 1 ? 0 : 92;
}
