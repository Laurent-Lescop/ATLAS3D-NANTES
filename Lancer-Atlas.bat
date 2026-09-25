@echo off
rem Atlas 3D de Nantes : lance le serveur local puis ouvre le navigateur.
chcp 65001 >nul
title Atlas 3D de Nantes
cd /d "%~dp0"
"%~dp0bin\atlas-windows-amd64.exe" -racine "%~dp0."
if errorlevel 1 pause
