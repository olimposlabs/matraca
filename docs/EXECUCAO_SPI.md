# Execução SPI do piloto Matraca

Execução autorizada em 10 de novembro de 2026. O fundador autorizou desenvolvimento e validação locais, commits, PRs, revisão Codex e merges. Não haverá deploy. AWS será configurada posteriormente. Trabalho paralelo está autorizado, inclusive em frentes independentes quando houver espera externa. Gates continuam explícitos, sem declarar fase concluída antes da evidência.

## Baseline

- Repositório remoto olimposlabs/matraca, inicialmente vazio.
- Branch de integração main.
- Baseline documental 0b18304, publicada na main.
- Plano aprovado em PLANO_DE_EXECUCAO_PILOTO.md.
- Stack ajustada à orientação de AWS futura. API Node/Fastify, PostgreSQL Docker, filesystem privado e jobs duráveis locais substituem a proposta Cloudflare.
- Avaliação livre e toggle de cursos por organização foram explicitados a partir dos requisitos já solicitados.

## Estado das fases

| Fase | Estado | Evidência |
| --- | --- | --- |
| 01 | Integrada com revisão independente e CI verde | PR #1, head 6dfb11e, merge 0336335 |
| 02 | Integrada com revisão independente e CI verde | PR #2, head 5fa7718, merge ffa1445 |
| 03 | Integrada com revisão independente e CI verde | PR #3, head 3f36442, merge de3cb8f |
| 04 | Integrada com revisão independente e CI verde | PR #4, head 7f52e78, merge b697603 |
| 05 | Integrada com revisão independente e CI verde | PR #5, head 8e45b2b, merge 2ef0f0e |
| 06 | Integrada com revisão independente e CI verde | PR #6, head c579a54, merge 89c8867 |
| 07 | Integrada com revisão independente e CI verde | PR #7, head 0aeae0a, merge 2c39dd5 |
| 08 | Integrada com revisão independente e CI verde | PR #8, head 7f4c6c1, merge 0b23ff5 |
| 09 | Integrada com revisão independente e CI verde | PR #9, head c564c8f, merge 38ca8b6 |
| 10 | Mentorias e plano individual validados, PR em preparação | 238 testes e quatro fluxos de navegador |
| 11–13 | Desenvolvimento paralelo | Worktrees locais por fase |
| 14 | Pendente | Dependências e aceite no plano aprovado |

Em 11 de novembro de 2026, o fundador autorizou o mecanismo de revisão independente com CI verde após a ausência de resposta do Codex Review no GitHub. As fases 01–04 foram integradas por PR na ordem, com o commit revisado fixado no merge e a mesma árvore validada pela CI. O ambiente local permaneceu em execução. AWS e deploy continuam para uma etapa futura.

## Fase 01

Escopo compreende ambiente, fundação web/API, banco persistente, armazenamento, prova de mídia, scripts e CI sem deploy. Não há comportamento de aplicação anterior a preservar. Documentos de produto existentes permanecem fontes de requisitos.

Riscos incluem formatos de mídia, recuperação de banco, host routing e divergência entre execução local e futura AWS. Rollback consiste em reverter o commit da fase e manter o volume PostgreSQL e diretório .data para inspeção. Não apagar dados para encobrir falhas de migração.

Testes, build, revisão independente e checks foram concluídos antes do merge de 11 de novembro. Deploy é não aplicável por instrução explícita. Não existe workflow de deploy.

### Evidências locais da fase 01

- Node 24.22.2, PostgreSQL 17, migração e seed executados.
- 30 testes aprovados, incluindo 15 provas de mídia e 13 casos de API/configuração, além de armazenamento privado.
- Typecheck, lint, build e audit de dependências aprovados. Audit reportou zero vulnerabilidades.
- Reinício real do container PostgreSQL preservou o seed. A API recuperou conexão e retornou saúde positiva depois do reinício.
- Host matraca.localhost:5173 resolve a interface e encaminha a API. Desktop e mobile inspecionados de 320 a 1440 pixels, sem overflow ou erro JavaScript.
- Prova de MediaRecorder real do Chromium usa vídeo sintético de canvas. MP4, WebM sem duração declarada, áudio, timestamps deslocados, truncamento e cinco minutos foram verificados.
- Docker Desktop teve helper de credenciais bloqueado. O bootstrap agora obtém a imagem pública com configuração temporária isolada e usa compose sem pull implícito, preservando credenciais do usuário.
- Revisão interna concluída sem achado bloqueante pendente no escopo. A integração do GitHub não retornou revisão. A revisão independente foi usada após a autorização.

## Fase 02

Baseline funcional 6dfb11e. Trabalho preparado em paralelo, conforme autorização explícita, enquanto o gate remoto da fase 01 aguarda revisão. O gate de saída da fase 02 não será declarado concluído antes da integração das dependências.

Escopo compreende identidades por organização, domínios cadastrados, login por token, cookies host-only, revogação, caixa de e-mail local privada e guardas de autorização. Critérios incluem mesma pessoa em várias organizações, uso único de token sob concorrência, expiração, suspensão e proteção contra elevação de papel. Rollback preserva tabelas e dados, reverte handlers e restringe acesso até nova validação.

A PR #1 teve CI validate aprovada no head 6dfb11e. Revisão foi solicitada por comentário @codex. O conector GitHub respondeu403 para criação da PR, e o GitHub CLI autenticado concluiu a abertura. Nenhuma proteção de branch foi alterada. Deploy continua ausente.

### Evidências locais da fase 02

- Migração 002 e seed aplicados. Existem seis alunos diretos, seis alunos do parceiro, três professores, gestor escolar, administrador da organização e operador em contexto separado.
- Tokens e sessões ficam como hashes no banco. E-mails simulados são arquivos privados, acessíveis pelo CLI local e negados pelo servidor Vite.
- Suíte integrada chegou a 59 testes aprovados. Os casos de identidade usam schema exclusivo de teste e mailbox temporária, sem limpar dados da demonstração.
- A revisão identificou exposição potencial da mailbox pelo servidor de desenvolvimento. Vite foi restrito aos diretórios públicos necessários, com teste HTTP de caminho relativo, /@fs e importação raw.
- O teste de Vite passou a usar cache próprio para não invalidar dependências do servidor de demonstração em execução.
- Revisão independente sem achado bloqueante adicional.

- E2E real confirmou cadastro direto, login Matraca/parceiro com o mesmo e-mail em contexto único de navegador, logout independente, rejeição de replay e acesso por papel a gestão e backoffice. Tokens não foram publicados em saídas.
- Build, lint, tipos e os 59 testes passaram após a integração. Screenshots de aluno, parceiro mobile e backoffice foram inspecionados.
- O mecanismo substituto foi autorizado e a PR #2 integrada após a PR #1.

## Fase 03

Baseline 5fa7718, fase 02 com PR #2 temporariamente empilhada sobre a fase 01. Ambas têm CI validate verde. Revisões independentes foram registradas nas PRs, com distinção explícita da integração GitHub Codex ainda sem retorno. A configuração de revisão automática do repositório foi verificada na interface e já estava ativa; nenhuma configuração foi alterada.

Escopo compreende provisionamento de parceiro, domínio local, administrador, gestão central, preferências, marca versionada, preview, restauração e logos normalizados. Rollback preserva histórico e objetos, reverte a versão do código e permite restaurar a marca pela revisão anterior. Deploy permanece não aplicável.

A suíte integrada tem 91 testes aprovados, incluindo 31 de organizações/branding e servidor do build. Lint, tipos e build passaram. O servidor compilado foi iniciado em porta local separada e entregou SPA e bundle com HTTP200. Instalação limpa usa defaults completos de branding no seed. A API valida contraste, rejeita referências de logo de outro tenant e impede a suspensão do próprio backoffice.

A inspeção do fluxo completo foi concluída antes da integração.

- E2E final da fase 03 aprovado. Criação de parceiro e login do novo administrador, preview sem publicação antecipada, upload staged, publicação, portal com marca, preferências, restauração e conflito409 foram exercitados pela interface.
- Não houve erro JavaScript nem overflow entre320 e1440px. A organização temporária e seus registros/arquivos foram removidos por IDs exatos. Personas e branding do seed permaneceram inalterados.
- Preparação da fase 04 iniciada em checkout separado a partir de3ba089e, conforme autorização de paralelismo. A fase 03 foi integrada após a fase 02.

## Fase 04

Baseline final3f36442. Escopo: gestão escolar, pessoas, aprovações, certificações, turmas, vínculos, grupos hierárquicos e transferências dentro da organização. O ID do aluno e os registros encerrados são preservados. As permissões seguem o vínculo atual; possuir histórico não garante acesso ao aluno após transferência.

A migração004 foi aplicada ao banco de demonstração. Seed aditivo cria uma escola, três professores aprovados, seis alunos, uma turma ativa e uma encerrada e quatro níveis de grupos. Reexecutar o seed não restaura vínculos encerrados nem sobrescreve edições.

Os20 testes específicos verificam isolamento, matrículas concorrentes, grupos sem ciclos, transferência e revogação. A revisão identificou uma janela de autorização durante espera pelo lock; a identidade passou a ser relida na mesma transação após adquirir o lock, com três regressões determinísticas de suspensão, papel e logout. Consulte [revisão independente](technical/PHASE04_REVIEW.md).

Validação integrada final:111 testes aprovados, tipos, lint, build e diff check passaram. O build da interface foi servido pelo backend local na porta3004 para a inspeção de navegador.

E2E real aprovado com cadastro de escola, aluno e turma, login do convidado, matrícula, vínculo docente, atribuição à turma, transferência e histórico. O professor recebeu200 antes e403 depois da transferência; o gestor da escola de destino recebeu200. Interface sem overflow de320 a1440px e sem erros de página. Fixtures sintéticas temporárias foram removidas por IDs exatos; seed permanece disponível.

Rollback reverte o código da fase e mantém as tabelas/históricos para inspeção. Não há deploy. A revisão independente, a CI e o merge da PR #4 foram confirmados em 11 de novembro.


## Fase 05

A carteira usa saldo, reservas e lançamentos imutáveis com origens FIFO. Cada aluno recebe um crédito inicial por organização. Concessões, pacotes, ajustes, estornos e limites escolares têm autorização por papel, idempotência e trilha de auditoria. Transferir um aluno preserva o saldo e o orçamento histórico da escola que concedeu.

A migração 005 foi aplicada no banco local. A revisão independente verificou 40 casos específicos, incluindo uma regressão de concorrência entre login e concessão da primeira carteira. O titular é bloqueado antes da carteira, evitando a espera circular. Consulte [a revisão](technical/PHASE05_REVIEW.md) e [os contratos](technical/CREDITS.md).

Passaram 151 testes integrados, typecheck, lint, build e diff check. Sete jornadas reais no navegador cobriram extrato, perda da resposta depois do commit, retomada sem duplicação, ajuste, pacote, limite escolar, estorno e backoffice. Desktop e celular foram inspecionados. Os saldos e a política foram restaurados por operações auditáveis. Os lançamentos sintéticos permanecem no extrato local.

Rollback preserva tabelas, saldos, reservas e lançamentos. Reverter a aplicação não exige remover a migração. O motor de avaliação e o faturamento serão integrados nas fases seguintes.

A PR #5 foi integrada à main em 11 de novembro de 2026 no merge 2ef0f0e, após revisão independente e CI verde no head 8e45b2b.


## Fase 06

O currículo integral foi importado com 12 módulos, 36 aulas e 12 revisões. Administradores podem criar e copiar cursos, editar rubricas, incluir anexos privados, publicar versões e atribuir. O backoffice opera em organização selecionada. A escola atribui versões publicadas às suas turmas e alunos. Publicações não alteram matrículas existentes, e novos alunos de uma turma recebem a versão mais recente atribuída.

A revisão independente encontrou e tratou republicação de curso arquivado, revogação após cancelamento de matrícula, integridade de imagens e versão atribuída a novos alunos. A migração 006 e o seed foram aplicados à demonstração. Treze jornadas de navegador em schema isolado verificaram editor, conteúdo, cópia, anexos, versões, atribuição, modo escolar e desativação de cursos. Consulte [os contratos](technical/COURSES.md) e [a revisão](technical/PHASE06_BACKEND_REVIEW.md).

Rollback preserva versões publicadas, matrículas e arquivos privados. Nenhum deploy foi executado.


## Fase 07

O estúdio captura áudio e vídeo no navegador ou recebe arquivo, com limite por atividade, prévia, descarte e cancelamento durante a transmissão. O servidor verifica os pacotes da mídia, registra duração e mantém o objeto privado. O player entrega ranges somente ao aluno e aos perfis com escopo pedagógico atual. Gravações livres continuam quando cursos estão desativados. Upload não debita créditos.

A revisão independente verificou 27 casos de mídia e autorização. Foram corrigidas a auditoria do upload e a restrição de diagnóstico por organização. Validação integrada registrou 198 testes, tipos, lint, build e Playwright com MediaRecorder real usando dispositivos sintéticos. Consulte [a revisão](technical/PHASE07_REVIEW.md) e [a validação de interface](technical/PHASE07_UI_VALIDATION.md).

Rollback preserva objetos e registros de gravação. Sem deploy.


## Fase 08

Avaliações de gravações reais usam provedor simulado. A mesma transação registra pedido, job, outbox e reserva. O worker tem lease e recuperação, limita tentativas e valida rubrica e evidências. Resultado e débito são atômicos. Cancelamento e falha definitiva liberam o saldo. O contexto retém objetivo, enunciado, cenário, perfil e resultados recentes do próprio aluno.

A revisão independente verificou transações, escopo, revogações durante espera, recuperação de lease e contexto. Passaram 215 testes integrados, tipos, lint, build e E2E com áudio real, relatório, player, saldo, cancelamento, falha definitiva e retry transitório. A migração 008 mantém os vínculos de mídia, resultado e consumo por organização e aluno. Consulte [os contratos](technical/EVALUATIONS.md) e [a revisão](technical/PHASE08_BACKEND_REVIEW.md).

Rollback preserva gravações, jobs, resultados e lançamentos. Suspenda o worker antes de reverter o código. Sem deploy.


## Fase 09

O portal do aluno abre a jornada com perfil, escolha de entrada, diagnóstico e cursos atribuídos. Sugestões adaptativas respeitam pré-requisitos e sequência obrigatória. O checklist salvo concede créditos de estudo uma vez. Avaliação válida conclui a atividade junto ao débito. A evolução separa rubricas, modalidades sem evidência e novas tentativas.

A revisão verificou locks e atomicidade. Um curso publicado agora só aceita pré-requisitos anteriores; versões antigas mantêm os requisitos em ordem topológica. Ativar sequência obrigatória após estudo adaptativo passa a bloquear a avaliação ainda incompleta até concluir as unidades anteriores. A migração 009 vincula progresso à versão e registra grupos por evento.

Passaram 217 testes integrados, tipos, lint, build e nove fluxos Playwright em schema isolado, com perfil, diagnóstico, áudio real, checklist, grants, revisão, nova tentativa, conclusão e comparação por rubrica. Consulte [a jornada](technical/JOURNEY.md). Rollback preserva histórico, progresso e lançamentos. Sem deploy.


## Fase 10

Professores aprovados e atribuídos registram mentorias e revisões humanas, com autoria e trechos da gravação. Alunos respondem e atualizam o plano. Gestores consultam e administram o plano no escopo atual. O relatório original da IA permanece separado e revisões humanas não debitam créditos.

Passaram 238 testes integrados, tipos, lint, build e quatro fluxos Playwright. A validação revelou uma lista obsoleta na troca de aba, corrigida e revalidada. A revisão independente confirmou vínculos atuais, revalidação, integridade dos registros e histórico de plano. Consulte [mentorias](technical/MENTORING.md). Rollback preserva histórico. Sem deploy.

A PR #10 foi integrada à main no merge 2371826, após revisão independente no head 1c29c74 e CI verde.

## Fase 11

A jornada registra pontos e medalhas de forma idempotente. Rankings anuais e campanhas isolam cada organização. Grupos usam os vínculos do momento do evento, inclusive depois da transferência. O fechamento da campanha salva a classificação e concede os créditos em uma transação.

Passaram 241 testes, tipos, lint, build e o roteiro de navegador `scripts/check-gamification-ui.ts` em desktop e celular. A suíte verifica fronteira anual no fuso de São Paulo, desempate, transferências, concessão de 3, 2 e 1 créditos e repetição de fechamento. Rollback preserva o histórico de pontos e prêmios. Sem deploy.

A revisão independente reproduziu uma medalha perdida quando duas transações consultavam pontos antes do commit. O cálculo passou a serializar eventos por aluno. A regressão e o Playwright passaram após a correção. A PR #11 foi integrada no merge 291a558, após CI verde no head 36c5c7f. [Revisão de gamificação](technical/PHASE11_BACKEND_REVIEW.md)

## Fase 12

O catálogo direto oferece cursos e pacotes. Pedidos guardam preço e versão, e a confirmação simulada entrega os benefícios uma vez. A loja aplica preços por volume ou progressivos. Contratos versionados guardam licenças, termos e faixas. Faturas registram consumo da competência, licenças do mês seguinte, elegibilidade histórica e ajustes.

Os roteiros Playwright usam API, PostgreSQL e armazenamento reais em schemas isolados. Verificaram catálogo, preço, matrícula, replay de pagamento e escopo. O fechamento de novembro do cenário sintético resultou em R$ 1.440, com três escolas e 50 alunos únicos. A publicação posterior preservou relatório, matrícula e fatura. A liquidação foi repetida após perda de resposta sem duplicação. [Contratos](technical/COMMERCE.md) · [Validação do comércio](technical/PHASE12_COMMERCE_UI_VALIDATION.md)

Rollback preserva os pedidos, benefícios, versões e faturas. Pagamentos são simulados. Sem deploy.

A PR #12 foi integrada no merge c45a339, após revisão independente e CI verde no head b6d6cbf. A suíte integrada executou 320 testes. Dois testes foram ajustados para injetar seu relógio financeiro pelo ponto de entrada do app.

## Fase 13

O backoffice tem métricas por organização, escola, aluno e período, auditoria, jobs e reservas. Valores simulados ficam separados dos minutos verificados e dos lançamentos de créditos. Políticas por organização controlam limites e cenários. O fechamento de fatura via interface e comando local usa a mesma função.

O navegador verificou filtros, limites, retomada de job e liberação de reserva órfã. Testes integrados verificaram cenário de pagamento e relógio financeiro por organização, preservação de histórico, permissões e limites. [Operação e recuperação](technical/OPERATIONS_CONSOLE.md)

Rollback preserva auditoria, jobs e lançamentos. Sem deploy.

A PR #13 foi integrada no merge af01836, após revisão independente e CI verde no head 0415246. A migração 013 foi aplicada ao ambiente principal local.

## Fase 14

A entrega reúne portal direto, white label e backoffice. O seed aditivo oferece seis alunos diretos e seis no parceiro, uma escola, três professores e o mesmo e-mail em dois domínios. O seed de exemplos inclui compra, gravação com avaliação, progresso, mentoria e contrato. Um sandbox pode incluir uma fatura fechada com relógio simulado. O seed foi limitado às identidades de demonstração e preserva professores novos no estado pendente.

As jornadas estão documentadas com suas verificações de UI, API e processo. Foram registrados os fluxos de cadastro e compra, curso completo com 48 unidades, revisão de 300 segundos, isolamento de domínios, fila recuperada após interrupção, histórico financeiro e persistência após reinício. O sandbox exige confirmação do nome para reset e recusa reset com processo ativo. [Matriz de aceite](technical/PILOT_ACCEPTANCE.md)

Os portais carregam as páginas por rota. A versão do currículo importada em ambientes novos exige áudio para critérios vocais. Versões publicadas e relatórios existentes preservam suas rubricas históricas. O piloto usa IA, e-mail e pagamento simulados. AWS, DNS público, deploy e validação em câmeras físicas pertencem às etapas posteriores.

Rollback preserva o banco, o armazenamento e as versões publicadas. Para reiniciar, use o mesmo nome, checkout e porta do sandbox. Para apagar um sandbox, use o comando com confirmação do nome. [Guia do piloto](GUIA_DO_PILOTO.md)
