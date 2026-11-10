# Smart Phases Implementation (SPI)

Use SPI quando o usuário solicitar SPI, SIP ou Smart Phases Implementation. Interprete SIP como SPI quando a referência for a esta metodologia, salvo definição explícita de outro processo. O protocolo também pode ser proposto para programas extensos, migrações ou remediações complexas. Inicie uma execução somente com um plano aprovado para executar o SPI. Ao discutir o método ou editar suas diretrizes, mantenha o estado de execução vigente.

Planeje fases pequenas com escopo, critérios de aceite e gate de saída explícitos. Execute uma fase por vez, preserve os identificadores originais do plano e mantenha cada PR dentro da fase em execução. Use o cabeçalho de execução previsto em [AGENTS.md](../AGENTS.md).

Por padrão, preserve respostas visíveis, contratos, autorização, idempotência, isolamento de dados, efeitos externos, ordem observável das operações, semântica das falhas, configuração efetiva e identidade dos recursos persistentes. Qualquer mudança de comportamento exige autorização explícita, teste de regressão, critério de aceite observável e rollback documentado.

## Ciclo de uma fase

1. **Baseline.** Registre branch e SHA de base, escopo, contratos e comportamentos a preservar, testes relevantes, riscos, critérios de aceite e rollback.
2. **Implementação.** Faça a menor mudança reversível que cumpra o escopo aprovado da fase.
3. **Reconciliação documental.** Atualize as fontes de verdade afetadas, remova afirmações obsoletas e registre limitações. Se os documentos continuarem corretos, registre no PR o resultado da auditoria semântica e a justificativa.
4. **Validação local.** Execute testes, lint, build e verificações de infraestrutura e documentação proporcionais ao diff, conforme o projeto. Registre o que ficou sem validação e por quê.
5. **PR de integração.** Crie o commit, faça push e abra uma PR pronta para revisão na branch de integração configurada. Inclua os SHAs de base e head, evidências, riscos, rollback e itens marcados como **Não confirmado**.
6. **Revisão.** Use GitHub Codex Review quando disponível. Aplique as regras de revisão abaixo ao head da PR.
7. **Merge.** Confira o SHA final, os checks obrigatórios verdes, a ausência de P0/P1 aplicável pendente e o tratamento de todos os achados menores. Se algum ciclo apontou P0/P1, exija uma revisão do head corrente que confirme a eliminação dos achados bloqueantes. Revalide após correções. Falhas de runner, cobrança ou limite externo bloqueiam o gate. Qualquer desvio das proteções de branch exige autorização.
8. **Deploys.** Compare os caminhos alterados com os filtros efetivos de CI/CD e acompanhe todos os deploys automáticos aplicáveis, inclusive os disparados por alterações de documentação.
9. **Pós-deploy.** Execute smoke tests e regressões proporcionais ao risco, de preferência em operações de leitura ou reversíveis, e compare os resultados com a baseline.
10. **Fechamento documental.** Registre os fatos observados sobre PR, revisão, checks, SHAs, deploys, smokes e rollback, além dos itens marcados como **Não confirmado**. Abra uma PR documental da mesma fase quando esses fatos só estiverem disponíveis após o merge funcional.
11. **Gate de saída.** Avance apenas quando código, revisão, checks, deploys aplicáveis, validação pós-deploy e documentação estiverem reconciliados.

Qualquer falha de gate mantém a fase aberta. Se a PR anterior já foi mergeada, corrija em nova PR da mesma fase e repita o trecho pertinente do ciclo antes de avançar.

## Regras de revisão

- Solicite revisão por ciclo da PR, sobre um head estável que reúna os commits da rodada. Aguarde o ciclo em curso antes de iniciar outro. Agrupe correções aplicáveis, responda a cada thread, revalide e use o segundo ciclo para examinar o head corrigido. O limite normal é de dois ciclos concluídos por PR. Se o primeiro ciclo confirmar zero P0/P1 e o head permanecer igual, encerre o exame desse head.
- P0 e P1 aplicáveis bloqueiam o merge e suspendem o limite. Corrija, revalide e solicite os ciclos necessários até uma revisão do head corrente confirmar zero P0/P1. A exceção se encerra com essa confirmação.
- Ao completar dois ciclos, se não houver P0/P1 aplicável pendente, encerre as solicitações motivadas apenas por P2/P3 ou achados de prioridade menor. Corrija antes do merge tudo que for necessário para segurança, aceite ou preservação comportamental, qualquer que seja a prioridade atribuída, e rode novamente a validação local e os checks. Para os demais achados aplicáveis, corrija no escopo ou registre um fast-follow explícito em [TECH_DEBT.md](TECH_DEBT.md), com origem, risco, prioridade, justificativa e critério de aceite. Responda com fundamento quando um achado for inaplicável.
- Se a ferramenta de revisão estiver indisponível, registre esse estado no gate e defina um mecanismo substituto aprovado. Registre as revisões que efetivamente ocorrerem.

## Promoção para produção

Se integração e produção tiverem ambientes e branches separados, a promoção constitui um gate adicional. Conclua todas as fases e validações na integração, confirme a autorização de release e abra uma PR separada da branch de integração para a branch de release. Repita checks, revisão, conferência do SHA e merge. Acompanhe todos os deploys de produção aplicáveis e execute os smokes de produção. A evidência de produção vem do deploy e da validação de produção.

Se o deploy estiver desabilitado, registre a promoção como bloqueada. Se o estado do deploy estiver sem evidência verificável, registre **Não confirmado**.

Promova também o fechamento documental para a branch de release quando necessário. Confira os filtros de CI/CD e acompanhe os deploys disparados por essa PR. Trate um deploy causado somente pelo próprio fechamento documental como evento terminal e encerre o registro desse resultado na PR e no status ao usuário. Abra um follow-up se houver incidente, dívida, divergência comportamental ou outro fato material.

Deploy manual, acesso a segredos, mutação de produção e operação destrutiva mantêm suas exigências próprias de autorização e preflight. Consulte [Operações](OPERATIONS.md).
