@echo off
setlocal EnableExtensions DisableDelayedExpansion
title CodexPro Personal - Supervised AI Tools

rem ------------------------------------------------------------
rem Core paths
rem ------------------------------------------------------------
set "ROOT=C:\Codex\projects"
set "TOOLS_ROOT=C:\Codex\tools"
set "CONFIG_ROOT=C:\Codex\config"
set "SKILLS_ROOT=%USERPROFILE%\.codex\skills"
set "AGENT_SKILLS_ROOT=%USERPROFILE%\.agents\skills"
set "BROWSER_ROOT=C:\Codex\browser"
set "AI_CHROME_PROFILE=%BROWSER_ROOT%\chrome-ai-profile"
set "CODEXPRO_SCRIPT=%TOOLS_ROOT%\codexpro-official-patch\package\scripts\codexpro.mjs"
set "SUPERVISOR=%TOOLS_ROOT%\codexpro-source\scripts\transport-supervisor.mjs"
set "DUAL_SUPERVISOR=%TOOLS_ROOT%\codexpro-source\scripts\dual-transport-supervisor.mjs"
set "LAUNCHER_LIFECYCLE=%TOOLS_ROOT%\codexpro-source\scripts\launcher-lifecycle.mjs"
set "LOG_ROOT=%TOOLS_ROOT%\codexpro-supervisor\dual-logs"
set "FALLBACK_LOG_ROOT=%TOOLS_ROOT%\codexpro-supervisor\logs"
set "LAUNCHER_LOG=%FALLBACK_LOG_ROOT%\launcher.log"
set "PROMOTE_REQUEST=%FALLBACK_LOG_ROOT%\promote-to-dual.request"

rem ------------------------------------------------------------
rem Dual transport / auth
rem ------------------------------------------------------------
set "TAILSCALE_BIN=C:\Program Files\Tailscale\tailscale.exe"
set "TAILSCALE_HOST=aaron.tailbdbf19.ts.net"
set "TAILSCALE_TARGET=http://127.0.0.1:8787"
set "NGROK_HOST=undusted-elite-populace.ngrok-free.dev"
set "NGROK_CONFIG=%LOCALAPPDATA%\ngrok\codexpro-personal.yml"
set "TOKEN_FILE=%USERPROFILE%\.codexpro\http-token"

rem ------------------------------------------------------------
rem Shared AI tool environment
rem ------------------------------------------------------------
set "CODEXPRO_INHERIT_ENV=1"
set "PLAYWRIGHT_BROWSERS_PATH=%TOOLS_ROOT%\playwright-browsers"
set "CODEXPRO_NGROK_LOG=%FALLBACK_LOG_ROOT%\ngrok.jsonl"
set "CODEXPRO_NGROK_LOG_FORMAT=json"
set "CODEXPRO_NGROK_LOG_LEVEL=info"
set "CODEXPRO_TUNNEL_RECOVERY_LOG=%FALLBACK_LOG_ROOT%\tunnel-recovery.jsonl"
set "CODEXPRO_TUNNEL_RECOVERY_INTERVAL_MS=7000"
set "CODEXPRO_TUNNEL_RECOVERY_THRESHOLD=3"

rem Optional non-secret shared environment file.
rem Keep passwords/tokens out of this file.
set "COMMON_ENV=%CONFIG_ROOT%\codexpro-common.cmd"
if exist "%COMMON_ENV%" call "%COMMON_ENV%"
set "CODEXPRO_LOCAL_CAPABILITIES=full"

rem ------------------------------------------------------------
rem Preflight
rem ------------------------------------------------------------
where node >nul 2>&1 || goto fail_node
if not exist "%CODEXPRO_SCRIPT%" goto fail_codexpro
if not exist "%SUPERVISOR%" goto fail_supervisor
if not exist "%ROOT%" goto fail_root
if not exist "%NGROK_CONFIG%" goto fail_ngrok
if not exist "%TOKEN_FILE%" goto fail_token
if not exist "%DUAL_SUPERVISOR%" goto fail_dual_supervisor
if not exist "%LAUNCHER_LIFECYCLE%" goto fail_launcher_lifecycle
if not exist "%TAILSCALE_BIN%" goto fail_tailscale
if not exist "%FALLBACK_LOG_ROOT%" mkdir "%FALLBACK_LOG_ROOT%"
set "TAILSCALE_PREFLIGHT_ATTEMPT=1"

:tailscale_preflight_retry
"%TAILSCALE_BIN%" status --json >nul 2>&1
if not errorlevel 1 goto tailscale_preflight_ok
if "%TAILSCALE_PREFLIGHT_ATTEMPT%"=="1" goto tailscale_preflight_retry_1
if "%TAILSCALE_PREFLIGHT_ATTEMPT%"=="2" goto tailscale_preflight_retry_2
echo [%date% %time%] TAILSCALE_PREFLIGHT_FAIL attempts=3 action=NGROK_FALLBACK>>"%LAUNCHER_LOG%"
goto fail_tailscale_state

:tailscale_preflight_retry_1
echo [%date% %time%] TAILSCALE_PREFLIGHT_RETRY attempt=1 delay=2s>>"%LAUNCHER_LOG%"
timeout /t 2 /nobreak >nul
set "TAILSCALE_PREFLIGHT_ATTEMPT=2"
goto tailscale_preflight_retry

:tailscale_preflight_retry_2
echo [%date% %time%] TAILSCALE_PREFLIGHT_RETRY attempt=2 delay=5s>>"%LAUNCHER_LOG%"
timeout /t 5 /nobreak >nul
set "TAILSCALE_PREFLIGHT_ATTEMPT=3"
goto tailscale_preflight_retry

:tailscale_preflight_ok
if not "%TAILSCALE_PREFLIGHT_ATTEMPT%"=="1" echo [%date% %time%] TAILSCALE_PREFLIGHT_RECOVERED attempt=%TAILSCALE_PREFLIGHT_ATTEMPT%>>"%LAUNCHER_LOG%"
where curl.exe >nul 2>&1
if not errorlevel 1 (
  curl.exe -sS -o NUL --max-time 2 http://127.0.0.1:8787/healthz >nul 2>&1
  if not errorlevel 1 goto fail_running
)

if not exist "%TOOLS_ROOT%" mkdir "%TOOLS_ROOT%"
if not exist "%CONFIG_ROOT%" mkdir "%CONFIG_ROOT%"
if not exist "%SKILLS_ROOT%" mkdir "%SKILLS_ROOT%"
if not exist "%AGENT_SKILLS_ROOT%" mkdir "%AGENT_SKILLS_ROOT%"
if not exist "%BROWSER_ROOT%" mkdir "%BROWSER_ROOT%"
if not exist "%AI_CHROME_PROFILE%" mkdir "%AI_CHROME_PROFILE%"
if not exist "%LOG_ROOT%" mkdir "%LOG_ROOT%"
if not exist "%FALLBACK_LOG_ROOT%" mkdir "%FALLBACK_LOG_ROOT%"

cd /d "%ROOT%"

echo Starting personal CodexPro - dual transport profile...
echo Primary: Tailscale Funnel https://%TAILSCALE_HOST%
echo Backup:  ngrok https://%NGROK_HOST%
echo Root: %ROOT%
echo Runtime: official 0.30.0 patched - single local runtime
echo ngrok public probe interval: 5 minutes
echo true-external MCP probe interval: 60 seconds
echo Public transport outages never restart the local runtime.
echo Logs: %LOG_ROOT%
echo Bash mode: full
echo Tool mode: full
echo Controls: q = normal quit (recommended), Ctrl+C = fallback quit.
echo.

set "LAUNCHER_SHA256="
for /f "usebackq delims=" %%S in (`node "%LAUNCHER_LIFECYCLE%" launcher-sha256 --launcher "%~f0"`) do set "LAUNCHER_SHA256=%%S"
if not defined LAUNCHER_SHA256 goto fail_launcher_sha
node "%LAUNCHER_LIFECYCLE%" validate-sha256 --value "%LAUNCHER_SHA256%" >nul 2>&1
if errorlevel 1 goto fail_launcher_sha

node "%DUAL_SUPERVISOR%" ^
  --name codexpro-personal-dual ^
  --local-health "http://127.0.0.1:8787/healthz" ^
  --tailscale-bin "%TAILSCALE_BIN%" ^
  --tailscale-host "%TAILSCALE_HOST%" ^
  --tailscale-target "%TAILSCALE_TARGET%" ^
  --ngrok-bin "ngrok.exe" ^
  --ngrok-host "%NGROK_HOST%" ^
  --ngrok-config "%NGROK_CONFIG%" ^
  --ngrok-api "http://127.0.0.1:4040/api/tunnels" ^
  --token-file "%TOKEN_FILE%" ^
  --log-dir "%LOG_ROOT%" ^
  --restart-launcher "%~f0" ^
  --launcher-sha256 "%LAUNCHER_SHA256%" ^
  --ngrok-log "%LOG_ROOT%\ngrok.jsonl" ^
  --cwd "%ROOT%" ^
  --interval-ms 15000 ^
  --failure-threshold 4 ^
  --probe-timeout-ms 5000 ^
  --ngrok-control-interval-ms 30000 ^
  --ngrok-public-interval-ms 300000 ^
  --external-mcp-interval-ms 60000 ^
  --external-dns-url "https://dns.google/resolve" ^
  --restart-base-ms 5000 ^
  --restart-max-ms 120000 ^
  --max-rapid-restarts 6 ^
  -- node "%CODEXPRO_SCRIPT%" start ^
    --tunnel none ^
    --headless ^
    --no-profile ^
    --root "%ROOT%" ^
    --allow-root "%SKILLS_ROOT%" ^
    --allow-root "%AGENT_SKILLS_ROOT%" ^
    --allow-root "%TOOLS_ROOT%" ^
    --allow-root "%CONFIG_ROOT%" ^
    --allow-root "%LOCALAPPDATA%\CodexPrivate\sec_smoke_approvals" ^
    --allow-root "%LOCALAPPDATA%\CodexPrivate\sec_smoke" ^
    --allow-root "%LOCALAPPDATA%\CodexPrivate\sec_archive" ^
    --allow-root "%LOCALAPPDATA%\CodexPrivate\sec_filing_shadow_replay" ^
    --allow-root "%LOCALAPPDATA%\CodexPrivate\sec_preparation" ^
    --token-file "%TOKEN_FILE%" ^
    --bash full ^
    --tool-mode full

set "EXIT_CODE=%ERRORLEVEL%"
if "%EXIT_CODE%"=="0" goto stopped
if "%EXIT_CODE%"=="42" goto fail_startup_identity

echo.
echo [WARN] Dual transport supervisor exited with code %EXIT_CODE%.
echo [WARN] Starting ngrok-only supervised fallback.
echo [%date% %time%] DUAL_SUPERVISOR_EXIT code=%EXIT_CODE% action=NGROK_FALLBACK>>"%LAUNCHER_LOG%"

:start_fallback
node "%SUPERVISOR%" ^
  --name codexpro-personal-fallback ^
  --local-health "http://127.0.0.1:8787/healthz" ^
  --public-health "https://%NGROK_HOST%/healthz" ^
  --ngrok-api "http://127.0.0.1:4040/api/tunnels" ^
  --log-dir "%FALLBACK_LOG_ROOT%" ^
  --tunnel-log "%CODEXPRO_NGROK_LOG%" ^
  --cwd "%ROOT%" ^
  --interval-ms 15000 ^
  --failure-threshold 4 ^
  --restart-on-public-failure off ^
  --probe-timeout-ms 5000 ^
  --healthy-reset-ms 300000 ^
  --restart-base-ms 5000 ^
  --restart-max-ms 120000 ^
  --max-rapid-restarts 6 ^
  -- node "%CODEXPRO_SCRIPT%" ngrok ^
    --headless ^
    --no-profile ^
    --root "%ROOT%" ^
    --allow-root "%SKILLS_ROOT%" ^
    --allow-root "%AGENT_SKILLS_ROOT%" ^
    --allow-root "%TOOLS_ROOT%" ^
    --allow-root "%CONFIG_ROOT%" ^
    --allow-root "%LOCALAPPDATA%\CodexPrivate\sec_smoke_approvals" ^
    --allow-root "%LOCALAPPDATA%\CodexPrivate\sec_smoke" ^
    --allow-root "%LOCALAPPDATA%\CodexPrivate\sec_archive" ^
    --allow-root "%LOCALAPPDATA%\CodexPrivate\sec_filing_shadow_replay" ^
    --allow-root "%LOCALAPPDATA%\CodexPrivate\sec_preparation" ^
    --hostname "%NGROK_HOST%" ^
    --ngrok-config "%NGROK_CONFIG%" ^
    --token-file "%TOKEN_FILE%" ^
    --bash full ^
    --tool-mode full
set "EXIT_CODE=%ERRORLEVEL%"
node "%LAUNCHER_LIFECYCLE%" consume-promotion --marker "%PROMOTE_REQUEST%" --launcher "%~f0" >"%FALLBACK_LOG_ROOT%\promotion-consume.json" 2>&1
if "%ERRORLEVEL%"=="0" goto promote_to_dual
goto stopped

:stopped
echo.
echo CodexPro stopped. Exit code: %EXIT_CODE%
pause
exit /b %EXIT_CODE%

:promote_to_dual
echo [%date% %time%] FALLBACK_PROMOTE_TO_DUAL action=CANONICAL_RELAUNCH>>"%FALLBACK_LOG_ROOT%\launcher.log"
start "" "%ComSpec%" /d /c ""%~f0""
exit /b 0

:fail_running
echo [ERROR] An existing CodexPro runtime is already responding on 127.0.0.1:8787.
echo Stop the existing CodexPro window before starting the supervised launcher.
goto fail

:fail_node
echo [ERROR] node.exe not found on PATH.
goto fail

:fail_codexpro
echo [ERROR] Patched CodexPro runtime not found:
echo %CODEXPRO_SCRIPT%
goto fail

:fail_supervisor
echo [ERROR] CodexPro transport supervisor not found:
echo %SUPERVISOR%
goto fail

:fail_dual_supervisor
echo [WARN] Dual transport supervisor not found. Using ngrok-only fallback:
echo %DUAL_SUPERVISOR%
goto prepare_fallback

:fail_launcher_lifecycle
echo [ERROR] Launcher lifecycle helper not found:
echo %LAUNCHER_LIFECYCLE%
goto fail

:fail_launcher_sha
echo [ERROR] Failed to derive or validate canonical launcher SHA-256.
goto fail

:fail_startup_identity
echo [ERROR] Dual supervisor rejected launcher startup identity. Fallback is disabled for this failure class.
echo [%date% %time%] DUAL_SUPERVISOR_STARTUP_IDENTITY_REJECT code=%EXIT_CODE% action=NO_FALLBACK>>"%LAUNCHER_LOG%"
goto fail

:fail_tailscale
echo [WARN] Tailscale CLI not found. Using ngrok-only fallback:
echo %TAILSCALE_BIN%
goto prepare_fallback

:fail_tailscale_state
echo [WARN] Tailscale is not connected yet. Using ngrok-only fallback.
goto prepare_fallback

:prepare_fallback
if not exist "%FALLBACK_LOG_ROOT%" mkdir "%FALLBACK_LOG_ROOT%"
cd /d "%ROOT%"
goto start_fallback

:fail_root
echo [ERROR] Workspace root not found:
echo %ROOT%
goto fail

:fail_ngrok
echo [ERROR] Personal ngrok config not found:
echo %NGROK_CONFIG%
goto fail

:fail_token
echo [ERROR] CodexPro HTTP token file not found:
echo %TOKEN_FILE%
goto fail

:fail
echo.
pause
exit /b 1
