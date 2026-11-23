@echo off
rem Multi-MCP start for Windows: double-click this file. It runs start.ps1 (next to it) with PowerShell.
rem "-ExecutionPolicy Bypass" applies to this one run only; it changes no setting on your computer.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
