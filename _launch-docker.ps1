$exe = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
if (Test-Path $exe) {
    Start-Process $exe
    Write-Host "Docker Desktop launched. Waiting for daemon..."
    for ($i = 0; $i -lt 30; $i++) {
        try {
            $result = docker info 2>&1 | Out-String
            if ($result -and -not $result.Contains("error")) {
                Write-Host "Docker daemon ready after $($i * 2) seconds."
                exit 0
            }
        } catch {}
        Start-Sleep -Seconds 2
    }
    Write-Host "Docker daemon not ready after 1 minute."
    exit 1
} else {
    Write-Host "Docker Desktop not found at $exe"
    exit 1
}
