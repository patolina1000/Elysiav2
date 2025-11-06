# Test script for Admin API
$token = "admin_87112524aA@"
$baseUrl = "http://localhost:3000"
$headers = @{ 
    Authorization = "Bearer $token"
    'Content-Type' = 'application/json'
}

Write-Host "`n=== Testing Admin API ===" -ForegroundColor Cyan

# Test 1: List bots
Write-Host "`n1. Listing bots..." -ForegroundColor Yellow
try {
    $response = Invoke-WebRequest -Uri "$baseUrl/api/admin/bots" -Headers $headers -UseBasicParsing
    Write-Host "✓ Status: $($response.StatusCode)" -ForegroundColor Green
    $bots = $response.Content | ConvertFrom-Json
    Write-Host "✓ Found $($bots.Count) bot(s)" -ForegroundColor Green
    $bots | ForEach-Object { Write-Host "  - $($_.name) ($($_.slug))" }
} catch {
    Write-Host "✗ Failed: $($_.Exception.Message)" -ForegroundColor Red
}

# Test 2: Create a test bot
Write-Host "`n2. Creating test bot..." -ForegroundColor Yellow
$newBot = @{
    name = "Test Bot $(Get-Date -Format 'HHmmss')"
    slug = "test-bot-$(Get-Date -Format 'HHmmss')"
    provider = "pushinpay"
    use_album = $true
    token = "8228680189:AAHFr7_lyYq36QdsHEkUhN_WqPSfc1TXM_I"
    rate_per_minute = 60
    sandbox = $false
    renderer = "MarkdownV2"
    typing_delay_ms = 0
} | ConvertTo-Json

try {
    $response = Invoke-WebRequest -Uri "$baseUrl/api/admin/bots" -Method POST -Headers $headers -Body $newBot -UseBasicParsing
    Write-Host "✓ Status: $($response.StatusCode)" -ForegroundColor Green
    $created = $response.Content | ConvertFrom-Json
    Write-Host "✓ Created bot: $($created.name) ($($created.slug))" -ForegroundColor Green
    Write-Host "✓ Webhook URL: $($created.webhook_url)" -ForegroundColor Green
    
} catch {
    Write-Host "✗ Failed: $($_.Exception.Message)" -ForegroundColor Red
}

# Test 3: Get bot details
Write-Host "`n3. Getting bot details..." -ForegroundColor Yellow
try {
    $detailResponse = Invoke-WebRequest -Uri "$baseUrl/api/admin/bots" -Headers $headers -UseBasicParsing
    $allBots = $detailResponse.Content | ConvertFrom-Json
    Write-Host "✓ Total bots in system: $($allBots.Count)" -ForegroundColor Green
} catch {
    Write-Host "✗ Failed: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host "`n=== All tests completed ===" -ForegroundColor Cyan
