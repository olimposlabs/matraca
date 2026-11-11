# F11 · revisão independente do backend

Escopo: `gamification.ts`, `gamification-core.ts`, integração de `journey-progress.ts` e migração 011. A revisão conferiu escopo de organização, grupos autorizados, critérios de ranking, concessão de medalhas e premiação em créditos.

## Achado corrigido

Duas conclusões simultâneas do mesmo aluno em matrículas diferentes podiam ultrapassar um limiar sem conceder a medalha. Cada worker travava sua própria matrícula, inseria seu XP e calculava os totais antes de a transação concorrente se tornar visível.

O caso foi reproduzido antes da correção com duas transações controladas: ambas leram seus totais antes de qualquer commit. Com 20 pontos em cada conclusão e limiar de 40, a asserção de uma medalha falhou observando zero medalhas.

A correção serializa `awardLearningEvent` pelo aluno com advisory lock no namespace 11, adquirido antes de inserir XP ou consultar totais. O namespace é distinto do lock 8 do fluxo de estudo; assim não introduz a inversão matrícula → lock de estudo em relação à ordem já existente estudo → matrícula.

A regressão final mantém a primeira transação aberta depois de inserir XP, observa a segunda aguardando o advisory lock real em `pg_locks`, libera a primeira e comprova 40 pontos e uma medalha. Não há alteração de schema nem concessão financeira adicional.

## Demais controles inspecionados

- Aluno acessa somente sua organização e os grupos atuais autorizados; o histórico de pontos mantém os grupos registrados no evento.
- Administração exige `org_admin`; o contexto central exige operador em organização backoffice. Mutações revalidam sessão e papel depois de aguardar o lock.
- A política usa revisão esperada e não recalcula pontos já atribuídos. Os nomes e as condições das medalhas conquistadas ficam registrados.
- O ranking anual usa os limites do ano em São Paulo, desempate por momento de alcançar os pontos e ID estável.
- Fechamento de campanha, snapshot da classificação e concessões dos prêmios compartilham transação. Chaves e restrições preservam uma única premiação por vencedor em reenvios e concorrência.

## Evidência

Após a correção, os quatro testes de `tests/gamification.test.ts` passaram, assim como TypeScript, ESLint dos arquivos alterados e `git diff --check`. A validação de interface está em `PHASE11_UI_VALIDATION.md`.
