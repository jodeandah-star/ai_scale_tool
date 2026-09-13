@echo off
chcp 65001 >nul
title AI Scale Tool Server
cd /d "%~dp0"
echo Starting AI Anthropomorphic Scale Tool...
echo.
node server.js
echo.
echo Server stopped. Press any key to close.
pause >nul
