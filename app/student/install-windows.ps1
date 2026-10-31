param([switch]$NodeOnly)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$runtime = Join-Path $root 'runtime/windows-x64'
$node = Join-Path $runtime 'node.exe'
$lock = Join-Path $root 'runtime/.install-lock'
$temp = $null
$locked = $false
$help = '请确认电脑能打开网页，再双击「启动-Windows.cmd」。仍不能打开时，重新下载并完整解压安装包，再启动。'
$stage = '检查运行环境'
function Invoke-LoggedNode([string]$Arguments, [string]$WorkingDirectory) {
    # Native stderr can contain successful npm notices; decide from the process exit code.
    $process = New-Object Diagnostics.Process
    $process.StartInfo.FileName = $node
    $process.StartInfo.Arguments = $Arguments
    $process.StartInfo.WorkingDirectory = $WorkingDirectory
    $process.StartInfo.UseShellExecute = $false
    $process.StartInfo.CreateNoWindow = $true
    $process.StartInfo.RedirectStandardOutput = $true
    $process.StartInfo.RedirectStandardError = $true
    try {
        [void]$process.Start()
        $output = $process.StandardOutput.ReadToEndAsync()
        $errors = $process.StandardError.ReadToEndAsync()
        $process.WaitForExit()
        Add-Content -LiteralPath (Join-Path $root 'runtime/install-error.log') -Encoding UTF8 -Value ($output.Result + $errors.Result)
        return $process.ExitCode
    } finally { $process.Dispose() }
}
try {
    Set-Location -LiteralPath $root
    if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64' -and $env:PROCESSOR_ARCHITEW6432 -ne 'AMD64') {
        $help = '请在 Windows 10 或 11 的 64 位电脑上使用这个安装包；这台电脑请联系帮你安装的人。'
        throw '本入口适用 Windows 10/11 x64，暂不支持这台电脑的处理器。'
    }
    if (Test-Path -LiteralPath $node) {
        $ready = $false
        try {
            if ($NodeOnly) { & $node --version *> $null } else { & $node 'app/student/start.mjs' --check *> $null }
            $ready = $LASTEXITCODE -eq 0
        } catch { $ready = $false }
        if ($ready) {
            if ($NodeOnly) { exit 0 }
            Write-Host '依赖已经齐全，无需再次下载。现在可以双击「启动-Windows.cmd」。'
            exit 0
        }
    }
    $stage = '准备下载'
    New-Item -ItemType Directory -Force (Join-Path $root 'runtime') | Out-Null
    try { New-Item -ItemType Directory $lock -ErrorAction Stop | Out-Null }
    catch { $help = '请回到已经打开的下载窗口，等它完成后，再双击「启动-Windows.cmd」。'; throw '已有下载窗口正在运行，请回到原窗口等待完成。' }
    $locked = $true
    $temp = Join-Path $root ('runtime/.download-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory $temp | Out-Null
    $filename = 'node-v24.21.0-win-x64.zip'
    $runtimeReady = $false
    if ((Test-Path -LiteralPath $node) -and (Test-Path -LiteralPath (Join-Path $runtime 'node_modules/npm/bin/npm-cli.js'))) {
        try {
            & $node --version *> $null
            $runtimeReady = $LASTEXITCODE -eq 0
        } catch { $runtimeReady = $false }
    }
    if (-not $runtimeReady) {
        $stage = '下载运行环境'
        Write-Host '[1/3] 下载这台 Windows 电脑的运行环境，请保持联网……'
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $archive = Join-Path $temp $filename
        Invoke-WebRequest -UseBasicParsing -TimeoutSec 900 -Uri ('https://nodejs.org/dist/v24.21.0/' + $filename) -OutFile $archive
        Write-Host '[2/3] 校验并解压运行环境……'
        $stage = '校验运行环境'
        $line = @(Get-Content -LiteralPath (Join-Path $root '依赖校验.sha256') -Encoding UTF8 | Where-Object { ($_ -split '\s+')[1] -eq $filename })
        if ($line.Count -ne 1) { throw '依赖校验文件不完整，请重新解压 ZIP。' }
        $expected = ($line[0] -split '\s+')[0]
        if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expected) { throw '下载文件校验失败，请重新点击下载依赖。' }
        $stage = '解压运行环境'
        $tar = Join-Path $env:SystemRoot 'System32/tar.exe'
        if (Test-Path -LiteralPath $tar) {
            & $tar -xf $archive -C $temp
            if ($LASTEXITCODE -ne 0) { throw '运行环境解压失败，请重新下载并完整解压安装包。' }
        } else {
            Add-Type -AssemblyName System.IO.Compression.FileSystem
            [IO.Compression.ZipFile]::ExtractToDirectory($archive, $temp)
        }
        $stage = '替换运行环境'
        if (Test-Path -LiteralPath $runtime) { Remove-Item -LiteralPath $runtime -Recurse -Force }
        Move-Item -LiteralPath (Join-Path $temp 'node-v24.21.0-win-x64') -Destination $runtime
    }
    if ($NodeOnly) {
        Write-Host '运行环境准备完成，正在打开 szu-uooc 控制台……'
        exit 0
    }
    $stage = '下载浏览器连接组件'
    Write-Host '[3/3] 下载浏览器连接组件……'
    $env:PATH = $runtime + ';' + $env:PATH
    $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
    $npmArguments = '"{0}" ci --ignore-scripts --omit=optional --no-audit --no-fund --registry=https://registry.npmjs.org --cache "{1}"' -f (Join-Path $runtime 'node_modules/npm/bin/npm-cli.js'), (Join-Path $root 'runtime/npm-cache')
    if ((Invoke-LoggedNode $npmArguments (Join-Path $root 'app')) -ne 0) { throw '组件下载失败，请检查网络后重新点击下载依赖。' }
    $stage = '检查浏览器连接组件'
    if ((Invoke-LoggedNode 'app/student/start.mjs --check' $root) -ne 0) { throw '依赖自检失败，请重新点击下载依赖。' }
    Write-Host '下载完成。现在可以双击「启动-Windows.cmd」；以后无需重复下载。'
} catch {
    $diagnostic = $_.ToString()
    $details = $_ | Format-List * -Force | Out-String
    try { New-Item -ItemType Directory -Force (Join-Path $root 'runtime') | Out-Null; Add-Content -LiteralPath (Join-Path $root 'runtime/install-error.log') -Encoding UTF8 -Value ("失败步骤：$stage`n原因：$diagnostic`n$details") } catch {}
    Write-Host ('失败步骤：' + $stage)
    Write-Host ('原因：' + $diagnostic)
    Write-Host $help
    Write-Host '仍不能打开时，把程序文件夹里的 runtime/install-error.log 发给帮你安装的人。'
    exit 1
} finally {
    if ($temp -and (Test-Path -LiteralPath $temp)) { Remove-Item -LiteralPath $temp -Recurse -Force }
    if ($locked) { Remove-Item -LiteralPath $lock -Force }
}
