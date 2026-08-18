# Subir o Wasteland Web num domínio (Hostinger)

O jogo é **100% estático**: HTML, JavaScript e arquivos de asset. Não precisa de
PHP, banco de dados nem Node no servidor — o mesmo pacote serve para Hostinger,
Netlify, Vercel, Cloudflare Pages ou qualquer hospedagem comum.

## Gerar o pacote

```bash
npm run build
```

Isso escreve tudo em `dist/`. Para gerar o `.zip` pronto para upload:

```bash
npm run package
```

O arquivo sai em `release/wasteland-web.zip`.

> O `npm run build` **não** regenera os assets do jogo. Se você mexeu em algo em
> `_assets_raw/` ou nos scripts de pipeline, rode `npm run assets:build` antes.

## Subir no Hostinger

1. hPanel → **Gerenciador de Arquivos** → entre em `public_html`.
2. Se for a raiz do domínio, apague o `index.html` de exemplo que vem lá.
3. **Envie o `wasteland-web.zip`** e use *Extrair* no próprio gerenciador.
   Enviar arquivo por arquivo também funciona, mas são 637 arquivos — o zip é
   muito mais rápido.
4. Confira que o `index.html` ficou **direto em `public_html/`**, e não dentro de
   uma pasta `dist/`. A estrutura final é:

   ```
   public_html/
     index.html
     .htaccess
     build/      ← JS e CSS com hash no nome
     assets/     ← modelos .glb, áudio .ogg, ícones, skins
   ```

5. Abra o domínio. O primeiro carregamento baixa cerca de **3 MB**; o resto
   (áudio e modelos dos POIs distantes) chega sob demanda.

### Subpasta funciona igual

O build usa caminhos **relativos**, então `seudominio.com/wasteland/` funciona
sem reconstruir nada — é só extrair o zip dentro da subpasta.

### O `.htaccess` vai junto

Ele está incluído no pacote e faz três coisas: declara os tipos MIME de `.glb` e
`.wasm` (sem isso alguns servidores entregam com um tipo que o navegador recusa),
liga a compressão do que ainda não vem comprimido, e põe cache longo nos arquivos
de `build/`, que têm hash no nome. Se o seu gerenciador de arquivos esconder
arquivos que começam com ponto, marque a opção de mostrar ocultos para conferir
que ele subiu.

## Depois de subir, confira

- O jogo abre e aparece "Clique para jogar".
- Abra o console do navegador (F12): não deve haver erro 404.
  O erro mais provável é `assets/manifest.json` não encontrado — significa que a
  pasta `assets/` não subiu ou ficou num nível errado.
- Pressione `F1` para o painel de debug e confira o FPS.

## Números do pacote

| | |
|---|---|
| Total em disco | 36 MB |
| Arquivos | 637 (580 são áudio) |
| Download inicial | ~3 MB (HTML, JS, CSS e 3 GLBs de pré-carga) |
| Restante | sob demanda, conforme o jogador anda pelo mapa |

Se a sua hospedagem tiver limite de **inodes** (quantidade de arquivos) apertado,
os 580 `.ogg` são a maior parte da contagem. Dá para cortar o áudio do pacote
removendo `dist/assets/audio/` — o jogo continua funcionando, silencioso, porque
o carregamento de áudio já tolera arquivo ausente.

## Licenças

Os assets são todos **CC0** (Kenney), então não há restrição para publicar.
Os créditos estão em `CREDITS.md` e valem uma linha no rodapé do site.
