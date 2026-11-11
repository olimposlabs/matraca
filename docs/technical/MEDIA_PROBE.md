# Prova de mídia — F01

`server/media/probe.ts` implementa a leitura de mídia finalizada no filesystem do
servidor Node. Usa somente o pacote base `mediabunny` em runtime; não usa API
externa, FFmpeg, WebCodecs nem decodificadores nativos para analisar o arquivo.
FFmpeg é uma dependência **de desenvolvimento** que gera os arquivos sintéticos
dos testes em um diretório temporário e os remove ao final.

## Contrato

```ts
const media = await probeMedia(privateStoragePath, {
  maxBytes: 200 * 1024 * 1024,
  maxDurationSeconds: 300,
  maxTracks: 8,
  maxPackets: 200_000,
  timeoutMs: 15_000,
  signal: abortController.signal,
});
```

Todas as opções numéricas são inteiros positivos. O resultado contém contêiner,
MIME obtido do conteúdo, tamanho efetivo, presença de áudio/vídeo, codec e contagem
de pacotes por trilha, início da apresentação e duração em segundos e em
microssegundos inteiros. O nome/extensão do arquivo e metadados do navegador não
participam do cálculo.

O chamador deve fornecer um caminho de armazenamento privado já autorizado, com
upload concluído e arquivo imutável. Esta função não recebe caminhos diretamente
do cliente, não autoriza acesso e não implementa upload, cobrança ou jobs. Esses
fluxos pertencem às fases posteriores. Links simbólicos são recusados na abertura.

Os erros públicos são `MediaProbeError` com códigos `INVALID_MEDIA`,
`UNSUPPORTED_MEDIA`, `LIMIT_EXCEEDED`, `IO_ERROR` ou `ABORTED`. Mensagens não expõem
o caminho interno. O descritor do arquivo e o parser são liberados também em erro.

## Semântica da duração

O parser percorre os **dados de todos os pacotes codificados**, não apenas a tag
de duração global. Para cada pacote, valida bytes disponíveis e timestamps finitos.
O timestamp final é a soma de início e duração do pacote; valores são normalizados
para microssegundos inteiros. Pacotes que terminam antes ou em zero são priming
do codec e não integram a apresentação. Inícios negativos restantes são limitados
a zero.

A duração é `maior fim − menor início` entre todas as trilhas apresentáveis.
Assim, um vídeo que começa em 12 segundos e termina em 13,2 segundos dura 1,2 segundo;
vídeo de um segundo junto de áudio de dois segundos ocupa dois segundos. Lacunas
internas contam como tempo de apresentação. O início original é devolvido para
alinhar posteriormente o player e as evidências. Uma fração de 1 ms além de um
minuto permanece `60_001_000` microssegundos, sem arredondamento para o minuto.

Esta prova mede a linha do tempo codificada. MP3 e outros codecs podem incluir
padding/frames completos além do áudio PCM original. Não há promessa de duração
idêntica à duração da fonte antes da codificação.

Os valores de crédito serão calculados no domínio financeiro a partir dessa
duração verificada. O probe não concede, reserva ou debita créditos.

## Formatos, integridade e limites

- MP4, incluindo trilhas de áudio/vídeo e áudio em contêiner MP4; WebM; WAV RIFF;
  MP3. Formatos externos, playlists e arquivos com dependências externas não são
  habilitados.
- O cabeçalho e todos os boxes MP4 externos precisam caber no arquivo. WAV RIFF
  não pode declarar tamanho maior que os bytes presentes. Leitura de pacotes e
  faixas incompletas é rejeitada. Arquivo vazio ou sem duração positiva também.
- Leituras por faixa têm cache de 2 MiB; uma requisição de leitura acima de 8 MiB
  é recusada. Há orçamento acumulado de oito vezes o tamanho do arquivo mais
  2 MiB, além dos limites de bytes, duração, trilhas, pacotes e timeout.
- Tamanho e alteração do arquivo são conferidos antes e depois da leitura.
  A imutabilidade após a análise continua sendo responsabilidade do armazenamento.

Validar estrutura e pacotes **não equivale a decodificar cada frame**. Alterações
no payload que preservem um contêiner estruturalmente válido podem não ser
detectadas. Cortar um fluxo sem duração declarada exatamente no limite de um
pacote pode produzir um arquivo curto válido; somente o protocolo de upload pode
comprovar que todos os bytes esperados chegaram. O futuro upload deve conferir
conclusão, tamanho e integridade de transporte antes de chamar o probe.

O timeout interrompe operações assíncronas; não é um limite rígido de CPU para
código síncrono dentro da biblioteca. Para processar mídia não confiável em escala,
o executor de jobs deve impor também isolamento e limite de execução do processo.

## Evidências reproduzíveis

```sh
npx vitest run tests/media-probe.test.ts
npx eslint server/media/probe.ts tests/media-probe.test.ts
npx tsc --noEmit
```

Prova local executada em 2026-11-10 com `mediabunny@1.65.2`:

| Caso | Resultado verificado |
| --- | --- |
| MP4/H.264 com extensão `.txt` | 12 pacotes; 1.200.000 µs; vídeo sem áudio |
| WebM/VP8 finalizado sem tag `Duration` | Duração da tag ausente; 1.200.000 µs medidos |
| Chromium `MediaRecorder` de canvas por 1,1 s | WebM/VP8 real, sem `Duration`; 29 pacotes; 1.098.000 µs na fixture inicial |
| WebM com timestamp inicial de 12 s | Início 12.000.000 µs; duração 1.200.000 µs |
| MP4 de cinco minutos | 600 pacotes; 300.000.000 µs |
| MP4 com vídeo de 1 s e áudio de 2 s | Duas trilhas; duração total 2.000.000 µs |
| WAV PCM e MP3 | Áudio real sem vídeo; WAV de 1.250.000 µs; MP3 dentro da duração de frames esperada |
| WAV de 60,001 s | 60.001.000 µs preservados |
| Duração global `mvhd` do MP4 adulterada | Pacotes continuam determinando 1.200.000 µs |
| MP4, WebM e WAV cortados em 70% dos bytes | `INVALID_MEDIA` nos três casos |
| Arquivo vazio, texto, limite de bytes/duração/trilhas/pacotes | Recusa com código esperado |
| Cancelamento prévio e arquivo inexistente | Recusa sem vazamento de caminho |

São 15 casos automatizados. `tests/fixtures/media/media-recorder.webm` é uma captura
real de `MediaRecorder` em Chromium via Playwright: canvas sintético, 25 fps,
gravação solicitada de 1.100 ms e chunks de 100 ms, `video/webm;codecs=vp8`.
O teste confere ausência de `Duration` e duração entre 1,0 e 1,3 s, tolerando a
temporização de frames de uma captura de 1,1 s. Não há imagem, voz ou dado de pessoa.
Essa prova cobre o formato produzido pelo navegador; não comprova permissão ou
compatibilidade de câmera/microfone físicos, que serão exercitados na fase 07.

## Referências consultadas

- [Mediabunny: leitura, duração e fontes por faixa](https://mediabunny.dev/guide/reading-media-files).
- [EncodedPacketSink: iteração de pacotes](https://mediabunny.dev/api/EncodedPacketSink).
- [EncodedPacket: timestamps, duração e bytes](https://mediabunny.dev/api/EncodedPacket).

Os resultados acima são observados nos testes locais, não uma afirmação de
compatibilidade com todos os codecs, dispositivos ou execução produtiva na AWS.

## Reprodução da fixture de navegador

Após instalar Chromium com `npx playwright install chromium`, execute `npx tsx scripts/generate-media-recorder-fixture.ts`. O gerador usa canvas sintético, MediaRecorder VP8/WebM e duração nominal de 1,1 segundo. Não usa câmera de pessoa real.
