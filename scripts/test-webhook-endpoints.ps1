# Script de testes para endpoints de webhook
# Execute: .\scripts\test-webhook-endpoints.ps1

$BASE_URL = "http://localhost:3000"
$ADMIN_TOKEN = "admin_87112524aA@"
$BOT_SLUG = "bot-ui-test"

$headers = @{
    'Authorization' = "Bearer $ADMIN_TOKEN"
    'Content-Type' = 'application/json'
}

Write-Host "`n=== TESTES DE WEBHOOK ===" -ForegroundColor Cyan
Write-Host ""

# Teste 1: SET Webhook
Write-Host "1️⃣  Teste: SET Webhook" -ForegroundColor Yellow
try {
    $response = Invoke-RestMethod -Uri "$BASE_URL/api/admin/bots/$BOT_SLUG/webhook/set" -Headers $headers -Method Post
    Write-Host "   ✅ Sucesso!" -ForegroundColor Green
    Write-Host "   📊 URL: $($response.webhook_url)" -ForegroundColor Cyan
    Write-Host "   📊 Response:" -ForegroundColor Cyan
    $response | ConvertTo-Json -Depth 5
} catch {
    Write-Host "   ❌ Erro: $($_.Exception.Message)" -ForegroundColor Red
    if ($_.ErrorDetails.Message) {
        $_.ErrorDetails.Message | ConvertFrom-Json | ConvertTo-Json
    }
}

Write-Host ""

# Teste 2: STATUS Webhook
Write-Host "2️⃣  Teste: STATUS Webhook" -ForegroundColor Yellow
try {
    $response = Invoke-RestMethod -Uri "$BASE_URL/api/admin/bots/$BOT_SLUG/webhook/status" -Headers $headers -Method Get
    Write-Host "   ✅ Sucesso!" -ForegroundColor Green
    Write-Host "   📊 URL: $($response.url)" -ForegroundColor Cyan
    Write-Host "   📊 Pending updates: $($response.pending_update_count)" -ForegroundColor Cyan
    Write-Host "   📊 Response completo:" -ForegroundColor Cyan
    $response | ConvertTo-Json -Depth 5
} catch {
    Write-Host "   ❌ Erro: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host ""

# Teste 3: Bot sem token
Write-Host "3️⃣  Teste: Bot sem token (negativo)" -ForegroundColor Yellow
try {
    $response = Invoke-RestMethod -Uri "$BASE_URL/api/admin/bots/bot-sem-token/webhook/set" -Headers $headers -Method Post
    Write-Host "   ⚠️  Atenção: Deveria ter falhado!" -ForegroundColor Yellow
    $response | ConvertTo-Json
} catch {
    $errorResponse = $_.ErrorDetails.Message | ConvertFrom-Json
    if ($errorResponse.error -eq "BOT_TOKEN_NOT_SET") {
        Write-Host "   ✅ Passou: Erro BOT_TOKEN_NOT_SET retornado" -ForegroundColor Green
        Write-Host "   📊 Response:" -ForegroundColor Cyan
        $errorResponse | ConvertTo-Json
    } else {
        Write-Host "   ❌ Falhou: Erro diferente do esperado" -ForegroundColor Red
        $errorResponse | ConvertTo-Json
    }
}

Write-Host ""

# Teste 4: DELETE Webhook (opcional)
Write-Host "4️⃣  Teste: DELETE Webhook (opcional)" -ForegroundColor Yellow
Write-Host "   💡 Descomente as linhas abaixo para executar" -ForegroundColor Gray
Write-Host ""
# try {
#     $response = Invoke-RestMethod -Uri "$BASE_URL/api/admin/bots/$BOT_SLUG/webhook/delete" -Headers $headers -Method Post
#     Write-Host "   ✅ Webhook removido!" -ForegroundColor Green
#     $response | ConvertTo-Json
# } catch {
#     Write-Host "   ❌ Erro: $($_.Exception.Message)" -ForegroundColor Red
# }

Write-Host "=== TESTES CONCLUÍDOS ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "💡 Próximos passos:" -ForegroundColor Yellow
Write-Host "   1. Verifique se a URL do webhook contém o domínio do ngrok"
Write-Host "   2. Envie /start no Telegram para testar o envio automático"
Write-Host "   3. Verifique os logs do servidor para confirmar o envio"
Write-Host "   4. Envie /start novamente para testar deduplicação"
Write-Host ""
