# F01 — revisão da fundação local

Esta é uma revisão interna independente do código da fase. Não foram identificados achados bloqueantes pendentes no escopo abaixo após a correção do pool e das dependências. Não substitui a revisão da PR pelo GitHub Codex Review nem atesta deploy, ambiente AWS ou conclusão do piloto.

## Escopo examinado

- `server/app.ts`, `server/config.ts`, `server/db.ts`, `server/storage.ts` e `server/start.ts`.
- Migração inicial, scripts de migração/seed e preparação do ambiente local.
- [Workflow de CI](../../.github/workflows/ci.yml) e [testes da fundação](../../tests/foundation.test.ts).

## Controles observados

- A API escuta em `127.0.0.1`; a configuração rejeita `APP_MODE` diferente de `local`.
- O guard de host aceita `localhost`, subdomínios de `.localhost` e `127.0.0.1`; rejeita sufixos externos. `trustProxy: false` impede que `X-Forwarded-Host` substitua implicitamente o host recebido.
- `/api/health` consulta PostgreSQL de fato. Falhas retornam `503` com mensagem controlada, sem incluir a URL de conexão. O pool tem limite de conexões e timeout de conexão e de consulta.
- A chave do storage local não aceita `..`, ponto, barra inicial ou caracteres de escape. Escritas usam arquivo temporário exclusivo com permissão `0600`, renomeação e remoção do temporário em caso de falha. O diretório local permanece sob controle do processo; isso não é uma autorização de acesso a objetos por aluno ou organização.
- Migrações usam transação, lock consultivo e checksum para detectar alteração de uma migração já aplicada. O seed inicial não sobrescreve a chave existente.
- A CI concede apenas `contents: read`, usa PostgreSQL 17 isolado com credenciais sintéticas e executa instalação reproduzível, lint, verificação de tipos, migrações, seed, testes e build em Node 24. Não contém job de deploy nem acesso a credenciais de nuvem.

## Evidências locais

| Verificação | Resultado observado |
| --- | --- |
| Lint do teste de fundação e `tsc --noEmit` com Node `24.22.2` | Passaram após a atualização definitiva do lockfile |
| Lint completo com Node `24.22.2` | Passou após a atualização definitiva do lockfile |
| `git diff --check` | Passou |
| `vitest run tests/foundation.test.ts` com Node `24.22.2`, Vitest `4.1.12` | 13 testes passaram, sem skips, com PostgreSQL real |
| PostgreSQL local | Container `postgres:17-alpine` saudável em `127.0.0.1:54329` |
| Smoke HTTP da API com `Host: piloto.localhost:3001` | Resposta de saúde `200`, banco `ok`, modo `local` |
| Smoke HTTP via proxy Vite com `Host: piloto.localhost:5173` | Resposta de saúde `200`, banco `ok`, modo `local` |
| `npm audit --json` após reinstalação e atualização do lockfile | Nenhuma vulnerabilidade reportada nas dependências de produção e desenvolvimento |
| CI Node 24 / PostgreSQL 17 no GitHub | **Não confirmado**; depende da execução do workflow na PR |

Os treze testes cobrem saúde real do banco, seis hosts locais com ou sem porta, três hosts externos ou enganosos, tentativa de override por `X-Forwarded-Host`, falha de conexão sanitizada e erro de conexão ociosa. A primeira rodada havia falhado nos casos positivos porque PostgreSQL ainda não estava disponível; esses casos passaram na repetição completa após iniciar o banco.

## Achado corrigido

O pool inicial de `server/db.ts` não registrava listener para o evento `error`. O código instalado de `pg-pool` emite esse evento ao perder conexão ociosa; sem listener, o processo Node pode encerrar. O listener foi adicionado e o teste de regressão passou: a emissão simulada do evento não lança exceção não capturada e o log não reproduz a URL ou a senha do erro. Esse teste verifica a fronteira do evento; não simula uma interrupção física do banco.

## Dependências de desenvolvimento

O primeiro `npm audit` encontrou dez entradas moderadas decorrentes de um único advisory de `minimatch` nas dependências de lint. A árvore de produção não apresentou vulnerabilidades. O [advisory GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) identifica correção a partir de `11.0.1`.

Foi validado inicialmente em um diretório temporário um override de `minimatch` para `11.0.5` sob `eslint`, `@eslint/config-array` e `@typescript-eslint/typescript-estree`. A instalação temporária apresentou audit sem vulnerabilidades e executou lint no repositório inteiro em Node 24 com sucesso. Os overrides foram incorporados ao projeto e o lockfile foi atualizado por uma instalação limpa: a auditoria subsequente da árvore completa reportou zero vulnerabilidades. Não foram aplicados os downgrades de ESLint sugeridos pelo `npm audit fix`.

## Limites desta fase

A allowlist local não implementa isolamento de organizações, autenticação, autorização, cookies de sessão, proteção de mídia por organização ou política de proxy em produção. Esses controles pertencem às fases de identidade e do piloto. A tabela de jobs é apenas a estrutura inicial; não comprova execução, lease ou recuperação de jobs. Nenhum desses recursos deve ser considerado validado por este relatório.
