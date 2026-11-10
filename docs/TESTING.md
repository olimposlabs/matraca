# Testes

Na criação destas diretrizes, não havia código de aplicação, manifesto ou suíte de testes na árvore de trabalho.

| Tema | Estado inicial |
| --- | --- |
| Ferramentas de teste, lint e build | **A definir** |
| Comandos confirmados no projeto | Nenhum nesta etapa |
| Medição de cobertura | **A definir** |

## Estratégia

- Inspecione os testes existentes antes de alterar comportamento. Atualize os casos afetados e acrescente regressões para bugs. Escolha o nível que verifica o comportamento observável e simule fronteiras externas quando necessário. Derive os resultados esperados dos contratos e critérios de aceite para manter as asserções independentes da lógica sob teste.
- Use os comandos definidos pelo projeto. Registre resultados e limitações da validação. Ao introduzir a primeira suíte, documente aqui comandos, pré-requisitos e lacunas conhecidas.
- Verifique links e a exatidão das afirmações sempre que a documentação mudar. Quando houver dependência de CI ou de um ambiente, consulte [Operações](OPERATIONS.md).
