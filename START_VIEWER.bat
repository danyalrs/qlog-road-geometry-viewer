@echo off
setlocal
cd /d "%~dp0"
echo Starting Qlog Road Geometry Viewer on http://localhost:3847
node server.js
