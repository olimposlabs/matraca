# F11 · conquistas e campanhas no portal

## Implementação

`client/gamification.tsx` exporta `GamificationPage` com os modos `student`, `manage` e `backoffice`; o CSS é isolado em `client/gamification.css`.

- `/app/achievements`: totais acumulados, medalhas conquistadas e ranking anual. O ranking aceita ano e comunidade autorizada, identifica a posição própria e pagina no servidor. A preferência que desativa o ranking preserva o mural pessoal de conquistas.
- `/admin/gamification`: somente o administrador da organização configura pontos, condições das medalhas e campanhas. O perfil de escola recebe uma explicação de acesso; não aparece um formulário de configuração sem permissão.
- `/backoffice/gamification`: o operador escolhe a organização e utiliza seus dados, sua comunidade e seus nomes de créditos.
- A publicação de regras envia a revisão esperada. Um conflito mantém a edição local visível, bloqueia novo envio com revisão obsoleta e permite recarregar explicitamente as regras atuais.
- A criação de campanha define nome, comunidade, datas e prêmios. Datas são apresentadas em Brasília e enviadas com deslocamento explícito UTC−3. O formulário mantém a mesma chave de intenção para repetir os mesmos valores após falha de transporte; uma edição cria uma intenção nova.
- A classificação parcial mostra os prêmios previstos. O encerramento exige uma confirmação com a campanha e os prêmios concretos; o resultado definitivo mostra o crédito efetivamente concedido. Repetições são protegidas também no servidor.

A interface usa os limites do contrato: até 30 medalhas; pontos inteiros de 0 a 100.000 por conclusão; até 100 posições de prêmio, com 1 a 10.000 créditos por posição. IDs das medalhas novas são gerados no cliente e não são campos técnicos expostos no fluxo de edição.

## Validação executada

`npm run build`, `npm run typecheck` e ESLint dos arquivos alterados passaram. O teste de navegador reproduzível é:

```sh
npm run build
npm exec tsx -- scripts/check-gamification-ui.ts
```

O script utiliza Chromium, o servidor real na porta 3011, um schema PostgreSQL exclusivo e armazenamento temporário. Ele encerra navegador/servidor e remove somente seus dados ao terminar. Não altera a base de demonstração nem depende de serviços externos.

Foram observados:

1. publicação de pontos e nova medalha;
2. edição concorrente por uma segunda chamada autenticada, conflito de revisão e recarga das regras atuais;
3. criação de campanha pela interface com período e três prêmios;
4. classificação parcial, confirmação do encerramento e três lançamentos de premiação na carteira;
5. repetição do encerramento sem novos lançamentos;
6. medalhas e totais do aluno, classificação própria, filtro de grupo e ano sem participantes;
7. layout do aluno em 390 px, sem rolagem horizontal do documento;
8. bloqueio da gestão para aluno e perfil de escola;
9. seleção da organização e leitura das mesmas regras pelo operador;
10. desativação do ranking mantendo as medalhas;
11. ausência de erros JavaScript de página.

As imagens sintéticas `.data/phase11-student.png`, `.data/phase11-mobile.png` e `.data/phase11-management.png` foram inspecionadas visualmente. Elas são artefatos locais ignorados pelo Git. Essa rodada valida Chromium local; não afirma compatibilidade já testada em Safari/Firefox nem substitui os testes de autorização, concorrência e apuração do backend.
