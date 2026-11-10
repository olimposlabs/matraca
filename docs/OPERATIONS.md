# Operações

O remoto é o repositório `olimposlabs/matraca` no GitHub. Na criação destas diretrizes, o remoto não tinha referências publicadas e a árvore de trabalho não tinha configuração de CI/CD.

| Tema | Estado inicial |
| --- | --- |
| Branch de integração, fluxo de PR e checks obrigatórios | **A definir** |
| Ambientes, contas, regiões e configuração de execução | **A definir** |
| CI/CD, filtros por caminho e deploys aplicáveis | **A definir** |
| Observabilidade, rollback e resposta a incidentes | **A definir** |
| Disponibilidade de Codex Review para o repositório | **Não confirmado** |

## Preflight operacional

- Antes de mudar infraestrutura ou operar um ambiente real, confirme identidade, conta ou workspace, ambiente, região quando aplicável, diff e impacto sobre recursos persistentes.
- Deploy manual, mutação de produção, acesso a segredos e operações destrutivas exigem a autorização e o preflight aplicáveis. Commit, PR, revisão e merge não ampliam essa autorização.
- Confirme os nomes das branches antes de usá-las. Só configure deploy automático quando houver uma decisão aprovada que estabeleça esse fluxo.
- Execute somente comandos de deploy confirmados no projeto. Registre aqui os procedimentos e os filtros efetivos de CI/CD assim que existirem. Para promoção no SPI, siga o [protocolo SPI](SMART_PHASES_IMPLEMENTATION.md).
