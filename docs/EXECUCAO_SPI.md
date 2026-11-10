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
| 01 | CI verde, aguardando revisão Codex | PR #1, head 6dfb11e |
| 02 | Implementação e validação locais concluídas, integração pendente | Branch codex/spi-02-identity |
| 03 | Código integrado, testes locais aprovados, E2E final em andamento | Branch codex/spi-03-portals-branding |
| 04–14 | Pendentes | Dependências e aceite no plano aprovado |

## Fase 01

Escopo compreende ambiente, fundação web/API, banco persistente, armazenamento, prova de mídia, scripts e CI sem deploy. Não há comportamento de aplicação anterior a preservar. Documentos de produto existentes permanecem fontes de requisitos.

Riscos incluem formatos de mídia, recuperação de banco, host routing e divergência entre execução local e futura AWS. Rollback consiste em reverter o commit da fase e manter o volume PostgreSQL e diretório .data para inspeção. Não apagar dados para encobrir falhas de migração.

Gate pendente de testes, build, revisão no head, checks, merge e smoke local. Deploy é não aplicável por instrução explícita. Não existe workflow de deploy.

### Evidências locais da fase 01

- Node 24.22.2, PostgreSQL 17, migração e seed executados.
- 30 testes aprovados, incluindo 15 provas de mídia e 13 casos de API/configuração, além de armazenamento privado.
- Typecheck, lint, build e audit de dependências aprovados. Audit reportou zero vulnerabilidades.
- Reinício real do container PostgreSQL preservou o seed. A API recuperou conexão e retornou saúde positiva depois do reinício.
- Host matraca.localhost:5173 resolve a interface e encaminha a API. Desktop e mobile inspecionados de 320 a 1440 pixels, sem overflow ou erro JavaScript.
- Prova de MediaRecorder real do Chromium usa vídeo sintético de canvas. MP4, WebM sem duração declarada, áudio, timestamps deslocados, truncamento e cinco minutos foram verificados.
- Docker Desktop teve helper de credenciais bloqueado. O bootstrap agora obtém a imagem pública com configuração temporária isolada e usa compose sem pull implícito, preservando credenciais do usuário.
- Revisão interna concluída sem achado bloqueante pendente no escopo. Revisão GitHub ainda pendente.

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
- Revisão independente sem achado bloqueante adicional. E2E de navegador e CI da fase ainda pendentes no momento deste registro.

- E2E real confirmou cadastro direto, login Matraca/parceiro com o mesmo e-mail em contexto único de navegador, logout independente, rejeição de replay e acesso por papel a gestão e backoffice. Tokens não foram publicados em saídas.
- Build, lint, tipos e os 59 testes passaram após a integração. Screenshots de aluno, parceiro mobile e backoffice foram inspecionados.
- Merges aguardam a revisão remota ou autorização do mecanismo substituto exigido pelo SPI. A pergunta foi enviada sem interromper implementação local independente.

## Fase 03

Baseline 5fa7718, fase 02 com PR #2 temporariamente empilhada sobre a fase 01. Ambas têm CI validate verde. Revisões independentes foram registradas nas PRs, com distinção explícita da integração GitHub Codex ainda sem retorno. A configuração de revisão automática do repositório foi verificada na interface e já estava ativa; nenhuma configuração foi alterada.

Escopo compreende provisionamento de parceiro, domínio local, administrador, gestão central, preferências, marca versionada, preview, restauração e logos normalizados. Rollback preserva histórico e objetos, reverte a versão do código e permite restaurar a marca pela revisão anterior. Deploy permanece não aplicável.

A suíte integrada tem 91 testes aprovados, incluindo 31 de organizações/branding e servidor do build. Lint, tipos e build passaram. O servidor compilado foi iniciado em porta local separada e entregou SPA e bundle com HTTP200. Instalação limpa usa defaults completos de branding no seed. A API valida contraste, rejeita referências de logo de outro tenant e impede a suspensão do próprio backoffice.

A inspeção de navegador do fluxo completo ainda está em andamento neste registro. Os gates remotos permanecem pendentes.
