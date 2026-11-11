# F07 — validação do estúdio no navegador

Implementação em `client/recordings.tsx` e `client/recordings.css`, ligada à rota protegida `/app/recordings` e à navegação do aluno. A reprodução de uma gravação e a extensão de ações para a avaliação são exportadas como componentes; não há chamada à IA nesta fase.

## Execução reproduzível

```sh
npm run build
npm exec tsx -- scripts/check-recordings-ui.ts
```

O script cria um schema PostgreSQL exclusivo, identidades sintéticas, uma sessão de teste e um diretório temporário de objetos. Serve o build na porta local3007, usa Chromium e remove banco e objetos do teste ao terminar. Não executa o seed nem modifica dados da demonstração. A porta precisa estar livre. Capturas de tela ficam em `.data/phase07-desktop.png` e `.data/phase07-mobile.png`.

O canal Chromium completo foi utilizado, com dispositivos sintéticos do próprio navegador. `getUserMedia`, `MediaRecorder`, arquivos resultantes, upload, duração verificada e reprodução são reais. O headless shell disponível neste ambiente retornou `NotSupportedError` para captura; o script usa explicitamente `channel: 'chromium'` para não confundir essa limitação do executável com funcionamento do produto.

## Jornadas verificadas

- Arquivo WAV real: escolha, prévia, objetivo e cenário de reunião executiva, upload, persistência e reprodução privada.
- Download por faixa: resposta206 e os16 bytes solicitados.
- Captura real de câmera e microfone no Chromium: prévia ao vivo, cronômetro, parada, arquivo WebM e metadados verificados com áudio e vídeo.
- Captura somente de áudio, troca de microfone, descarte e preferência de dispositivo preservada após recarregar.
- Cancelamento do envio na interface, conservando a prévia e sem criar registro. O transporte é pausado antes da transmissão para controlar esse teste; a interrupção real no meio de um multipart é testada separadamente por `tests/recordings.test.ts`.
- Sessão com permissão de câmera/microfone negada pelo navegador: mensagem de orientação e alternativa de arquivo.
- Falta de dispositivo, simulada por `NotFoundError`: mensagem correspondente e seleção de arquivo disponível.
- Histórico conservado após recarga, player e contagem esperada de gravações.
- Layout de390 pixels sem transbordamento horizontal; inspeção visual das capturas desktop e móvel.

Não houve erro de JavaScript na página durante os cenários executados. Build, TypeScript e lint dos arquivos alterados passaram. A suíte integrada de backend anterior à ligação da interface passou com196 testes em13 arquivos; inclui os27 testes específicos de gravação.

## Comportamento de cancelamento e limites

O botão de cancelamento fica disponível enquanto os bytes são transmitidos. Ao chegar a100%, a interface mostra a validação do arquivo e desabilita o botão: abortar uma resposta HTTP depois de transmitir todo o corpo não garante que o servidor receba sinal de cancelamento. Perda de conexão ou timeout orienta consultar o histórico antes de reenviar. Upload não consome créditos.

A ambientação é ilustrativa e estática, explicitamente identificada na tela: conversa, reunião com seis pessoas e grande plateia. Não simula respostas em tempo real. A prévia e as escolhas locais não são enviadas até o aluno salvar. A aplicação encerra tracks ao parar, trocar dispositivo, descartar ou sair da tela. Preferências de dispositivo são locais ao host e à identidade, sem necessidade de permissão para listar opções já disponíveis.

O teste automatizado usa dispositivos sintéticos. Câmeras físicas, navegadores Safari/Firefox e variações de permissão do sistema operacional não foram confirmados nesta rodada. O cliente verifica suporte a captura e formatos, mantém alternativa de upload e deixa a duração final a cargo do servidor.

Referências de implementação: [MDN — MediaRecorder.isTypeSupported](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/isTypeSupported_static), [MDN — getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia), [MDN — progresso de XMLHttpRequest](https://developer.mozilla.org/en-US/docs/Web/API/XMLHttpRequest/upload).
