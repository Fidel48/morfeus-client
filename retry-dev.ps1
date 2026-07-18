$env:Path += ";C:\Users\fidel\.cargo\bin"
Stop-Process -Name "node" -Force -ErrorAction SilentlyContinue
Stop-Process -Name "morfeus-client" -Force -ErrorAction SilentlyContinue

$max_retries = 15
$i = 0
do {
    Write-Host "Attempt $($i + 1) to launch app..."
    npm run tauri dev
    $exitCode = $LASTEXITCODE
    if ($exitCode -eq 0 -or $exitCode -eq 130) {
        Write-Host "App exited cleanly."
        break
    }
    Write-Host "Crash detected (likely Windows Defender file lock). Retrying in 2 seconds..."
    $i++
    Start-Sleep -Seconds 2
} while ($i -lt $max_retries)
