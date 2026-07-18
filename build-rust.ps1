$env:Path += ";C:\Users\fidel\.cargo\bin"
$env:CARGO_BUILD_JOBS = 2

$maxRetries = 15
$retryCount = 0
$success = $false

while (-not $success -and $retryCount -lt $maxRetries) {
    Write-Host "Building Rust backend (Attempt $($retryCount + 1))..."
    cd src-tauri
    cargo build
    $exitCode = $LASTEXITCODE
    cd ..
    
    if ($exitCode -eq 0) {
        $success = $true
        Write-Host "Build succeeded!"
    } else {
        $retryCount++
        Write-Host "Build failed (likely file lock). Retrying in 3 seconds..."
        Start-Sleep -Seconds 3
    }
}
