@echo off
powershell.exe -ExecutionPolicy Bypass -File "%~dp0scripts\restart-all-public.ps1" %*
