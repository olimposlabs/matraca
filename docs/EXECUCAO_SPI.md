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
| 01 | Validação local concluída. PR e revisão pendentes | Branch codex/spi-01-foundation |
| 02–14 | Pendentes | Dependências e aceite no plano aprovado |

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
