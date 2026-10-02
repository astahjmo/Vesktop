# Publicando uma versão do fork

O fork gera instaladores para Linux, Windows e macOS pela CI (`.github/workflows/release.yml`)
e o app atualiza sozinho a partir dos Releases deste repositório (`astahjmo/Vesktop`).

## Passo a passo

1. Suba a versão em `package.json` (semver simples: `1.6.8` → `1.6.9`).
2. Faça commit e crie a tag com o mesmo número:

   ```sh
   git tag v1.6.9
   git push origin v1.6.9
   ```

3. A CI builda as três plataformas e anexa os arquivos a um Release em **rascunho**.
4. Confira os arquivos na página de Releases e clique em **Publish release**.
   Só depois disso o auto update dos apps instalados enxerga a versão nova.

> Não use sufixos como `1.6.9-beta.1`: o `electron-updater` trata o sufixo como "canal" e
> passa a procurar outro arquivo de atualização.

## O que sai em cada plataforma

| Plataforma | Arquivos | Atualização |
|---|---|---|
| Linux | AppImage, deb, rpm, pacman (x64), tar.gz | AppImage troca o próprio arquivo; deb/rpm/pacman usam o gerenciador de pacotes (pedem senha) |
| Windows | instalador NSIS e zip (x64/arm64) | automática (o SmartScreen avisa na 1ª instalação: não há certificado) |
| macOS | dmg e zip (universal) | **manual**: sem certificado Apple o app não é assinado, então o botão de atualizar abre a página do Release |

No macOS, na primeira abertura: clique com o botão direito no app → **Abrir**, ou rode
`xattr -cr /Applications/Vesktop.app` se aparecer "app danificado".

## Acompanhando o Vesktop original

`.github/workflows/sync-upstream.yml` roda todo domingo, faz merge de `Vencord/Vesktop@main`
numa branch `sync/upstream-AAAAMMDD` e abre um PR para `feat/buteco-games`. Os conflitos
esperados ficam nos arquivos tocados fora das pastas `buteco/` (seletor de tela, `main.ts`,
preload, `IpcEvents`).

## Para rodar a CI no fork

Forks nascem com o Actions desligado: ligue em **Actions** na página do repositório.
