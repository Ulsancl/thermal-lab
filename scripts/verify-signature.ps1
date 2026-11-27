param(
    [Parameter(Mandatory = $true)][string]$Target,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F]{40}$')][string]$Thumbprint
)
$ErrorActionPreference = 'Stop'
$signature = Get-AuthenticodeSignature -LiteralPath $Target
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Thumbprint -ine $Thumbprint) {
    throw "Authenticode verification failed for $([IO.Path]::GetFileName($Target)): $($signature.Status) or unexpected signer"
}
Write-Output "Verified Authenticode signature for $([IO.Path]::GetFileName($Target))"
