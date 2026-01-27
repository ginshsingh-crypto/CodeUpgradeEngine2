@echo off
setlocal EnableDelayedExpansion

echo ========================================
echo   LOD 400 Uploader - Add-in Installer
echo ========================================
echo.

REM Get the directory where this script is located
set "SCRIPT_DIR=%~dp0"

set "INSTALLED=0"

for %%V in (2024 2023 2022) do (
    set "REVIT_ADDINS=%APPDATA%\Autodesk\Revit\Addins\%%V"
    if exist "!REVIT_ADDINS!" (
        echo.
        echo Installing for Revit %%V...
        
        REM Try Release build first, then Debug
        if exist "%SCRIPT_DIR%LOD400Uploader\bin\Release\net48\LOD400Uploader.dll" (
            copy /Y "%SCRIPT_DIR%LOD400Uploader\bin\Release\net48\LOD400Uploader.dll" "!REVIT_ADDINS!\" >nul
            echo   Copied Release DLL
        ) else if exist "%SCRIPT_DIR%LOD400Uploader\bin\Debug\net48\LOD400Uploader.dll" (
            copy /Y "%SCRIPT_DIR%LOD400Uploader\bin\Debug\net48\LOD400Uploader.dll" "!REVIT_ADDINS!\" >nul
            echo   Copied Debug DLL
        ) else (
            echo   ERROR: DLL not found. Please build the project first.
            echo   Run: dotnet build -c Release
            goto :end
        )
        
        REM Copy addin manifest
        copy /Y "%SCRIPT_DIR%LOD400Uploader\LOD400Uploader.addin" "!REVIT_ADDINS!\" >nul
        
        echo   Installed to: !REVIT_ADDINS!
        set "INSTALLED=1"
    )
)

:end
echo.
if "!INSTALLED!"=="1" (
    echo ========================================
    echo   Installation Complete!
    echo ========================================
    echo.
    echo Please restart Revit to use the add-in.
    echo Look for "LOD 400" tab in the ribbon.
    echo.
) else (
    echo ========================================
    echo   No Revit Installation Found
    echo ========================================
    echo.
    echo Could not find Revit 2022, 2023, or 2024.
    echo Please install Revit first, then run this again.
    echo.
)

endlocal
pause
