' ============================================================
' HYPEROOM v2 — Home Server Launcher
' Start: PostgreSQL + backend (:3100) + PWA (:3101) + buka browser
' Dipakai di: Desktop (double-click) & Startup (autostart)
' ============================================================

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

BASE   = "H:\TRISULA_DIGIART\hyperoom-v2"
LOGS   = BASE & "\logs"
PGBIN  = "H:\HYPEROOM-SERVER\storage\private\downloads\pgbin\pgsql\bin"
PGDATA = "H:\HYPEROOM-SERVER\storage\pgdata"

' --- pastikan folder logs ada ---
If Not fso.FolderExists(LOGS) Then fso.CreateFolder(LOGS)

' --- 1) PostgreSQL :5432 (cek dulu, jangan start dobel) ---
pgRunning = sh.Run("cmd /c ""tasklist /FI ""IMAGENAME eq postgres.exe"" | findstr postgres.exe >nul""", 0, True)
If pgRunning <> 0 Then
  sh.Run "cmd /c """"" & PGBIN & "\postgres.exe"" -D """ & PGDATA & """ -p 5432 >> """ & LOGS & "\postgres.log"" 2>&1""", 0, False
End If

' --- 2) Backend :3100 (cek port) ---
port3100busy = sh.Run("cmd /c ""netstat -ano | findstr :3100 | findstr LISTENING >nul""", 0, True)
If port3100busy <> 0 Then
  sh.Run "cmd /c ""cd /d """ & BASE & "\server"" && npx tsx src/index.ts >> """ & LOGS & "\server.log"" 2>&1""", 0, False
End If

' --- 3) PWA :3101 (cek port) ---
port3101busy = sh.Run("cmd /c ""netstat -ano | findstr :3101 | findstr LISTENING >nul""", 0, True)
If port3101busy <> 0 Then
  sh.Run "cmd /c ""cd /d """ & BASE & "\apps\pwa"" && npx vite --host >> """ & LOGS & "\pwa.log"" 2>&1""", 0, False
End If

' --- 4) tunggu server siap, baru buka browser ---
sh.Run "cmd /c ""timeout /t 6 /nobreak >nul & start http://localhost:3101""", 0, False