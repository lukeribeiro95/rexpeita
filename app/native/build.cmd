@echo off
rem Compila tela-loopback.exe (precisa do Visual Studio Build Tools 2022 com C++).
setlocal
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
for /f "usebackq delims=" %%i in (`"%VSWHERE%" -latest -products * -property installationPath`) do set "VSDIR=%%i"
call "%VSDIR%\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1 || exit /b 1
cd /d "%~dp0"
if not exist bin mkdir bin
cl /nologo /EHsc /O2 /std:c++17 /W3 tela-loopback.cpp /Fo:bin\ /Fe:bin\tela-loopback.exe ole32.lib mmdevapi.lib || exit /b 1
del bin\*.obj
