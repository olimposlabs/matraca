# Pontos, medalhas, rankings e prêmios

A conclusão de aula, revisão ou curso gera um evento único. O evento grava grupos vigentes e ancestrais ativos. A política vigente determina pontos e condições de medalhas. O lançamento mantém revisão da política, e a medalha mantém nome e condição aplicados. Alterações passam a valer nos próximos marcos. Marcos anteriores à migração recebem a política inicial.

O ranking usa o ano de São Paulo e exibe apenas participantes ativos da mesma organização. Um grupo usa o vínculo registrado no evento. Uma transferência não desloca pontos antigos. O desempate é pela data em que o total foi atingido e, em seguida, pelo identificador estável. Alunos consultam apenas seus grupos atuais e o ranking da organização. Desativar ranking não interrompe o registro do progresso pessoal.

Administradores e backoffice publicam regras com revisão otimista e criam campanhas com chave de idempotência. O período é fechado à esquerda e aberto à direita. Após o fim, o fechamento captura a classificação, concede créditos por posição e grava seus lançamentos em uma única transação. Repetir o fechamento devolve o snapshot. Pontos e créditos são unidades distintas.

Rotas do aluno: `GET /api/gamification` e `GET /api/gamification/leaderboard` com ano, grupo e paginação. Gestão usa `/api/gamification/manage` e backoffice `/api/backoffice/gamification/:orgId`, com `policy`, `campaigns`, detalhe e fechamento. A migração 011 acrescenta regras, pontos, medalhas e snapshots. Evidências de interface em [PHASE11_UI_VALIDATION.md](PHASE11_UI_VALIDATION.md).
