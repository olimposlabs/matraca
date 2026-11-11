# Testes

A fase 01 introduz Vitest para API, armazenamento e prova de mídia, TypeScript estrito, ESLint e build Vite. As jornadas Playwright serão acrescentadas junto das telas funcionais.

| Comando | Finalidade |
| --- | --- |
| npm run typecheck | Tipos de cliente, servidor e testes |
| npm run lint | Análise estática |
| npm test | Testes locais. Requer banco para os testes de saúde positivos |
| npm run build | Tipos e build da interface |
| npm run test:e2e | Jornadas de navegador, a serem incluídas nas fases de produto |

As fixtures de mídia são sintéticas. FFmpeg é usado apenas para gerar amostras de teste. O probe de produção usa mediabunny. Nenhuma pessoa real aparece nas fixtures.

Resultados e limitações estão no [registro SPI](EXECUCAO_SPI.md). A existência de um comando não representa validação concluída.

## Estratégia

- Inspecione os testes existentes antes de alterar comportamento. Atualize os casos afetados e acrescente regressões para bugs. Escolha o nível que verifica o comportamento observável e simule fronteiras externas quando necessário. Derive os resultados esperados dos contratos e critérios de aceite para manter as asserções independentes da lógica sob teste.
- Use os comandos definidos pelo projeto. Registre resultados e limitações da validação. Ao introduzir a primeira suíte, documente aqui comandos, pré-requisitos e lacunas conhecidas.
- Verifique links e a exatidão das afirmações sempre que a documentação mudar. Quando houver dependência de CI ou de um ambiente, consulte [Operações](OPERATIONS.md).
