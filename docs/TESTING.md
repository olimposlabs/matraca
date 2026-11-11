# Testes

A suíte usa Vitest para contratos, autorização e persistência em PostgreSQL, Playwright para fluxos no navegador, TypeScript, ESLint e build Vite.

| Comando | Finalidade |
| --- | --- |
| npm run typecheck | Tipos de cliente, servidor e testes |
| npm run lint | Análise estática |
| npm test | Testes unitários e de integração. Inicie o banco local antes de executar. |
| npm run build | Tipos e build da interface |
| npm run test:e2e | Jornadas Chromium com API e PostgreSQL locais em schemas descartáveis |

As fixtures de mídia são sintéticas. FFmpeg é usado apenas para gerar amostras de teste. O probe de produção usa mediabunny. Nenhuma pessoa real aparece nas fixtures.

Prepare as jornadas com `npm run db:start`, `npx playwright install chromium` e `npm run build`. Execute `npm run test:e2e`. Cada roteiro usa armazenamento temporário e portas próprias. Capturas de tela ficam em `.data`. A matriz descreve a cobertura de cada jornada, incluindo verificações manuais e lacunas. [Matriz de aceite](technical/PILOT_ACCEPTANCE.md) · [Registro SPI](EXECUCAO_SPI.md)

## Estratégia

- Inspecione os testes existentes antes de alterar comportamento. Atualize os casos afetados e acrescente regressões para bugs. Escolha o nível que verifica o comportamento observável e simule fronteiras externas quando necessário. Derive os resultados esperados dos contratos e critérios de aceite para manter as asserções independentes da lógica sob teste.
- Use os comandos definidos pelo projeto. Registre resultados e limitações da validação. Ao introduzir a primeira suíte, documente aqui comandos, pré-requisitos e lacunas conhecidas.
- Verifique links e a exatidão das afirmações sempre que a documentação mudar. Quando houver dependência de CI ou de um ambiente, consulte [Operações](OPERATIONS.md).
