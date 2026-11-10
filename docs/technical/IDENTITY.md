# Identidade e isolamento — F02

`server/auth.ts` registra os endpoints locais de identidade por
`registerIdentity(app)`. PostgreSQL persiste organizações, domínios, usuários,
tokens, sessões, contadores de frequência e auditoria. A migração é
`server/migrations/002_identity.sql`.

## Fronteira de organização

Cada hostname precisa existir em `domains`; o servidor resolve a organização
antes de atender a API. `/api/health` é a exceção explícita. Host desconhecido
retorna 404 e nunca escolhe uma organização padrão. O host recebido ainda passa
pela restrição de desenvolvimento local de `server/config.ts`.

Identidade é única por `(org_id, email)` normalizado com trim e lowercase. O mesmo
e-mail pode ter nome, papéis, situação e histórico distintos em organizações
diferentes. Tokens e sessões usam chaves estrangeiras compostas para vincular
usuário e domínio à mesma organização.

`getIdentity(request)` retorna `AuthIdentity | null` após consultar novamente
sessão, domínio, organização e usuário. `requireIdentity(request, allowedRoles?)`
exige sessão válida e, quando informado, pelo menos um dos papéis autorizados.
Ausência de login produz 401; papel insuficiente produz 403. A autorização não
usa um cache que mantenha usuários suspensos ativos.

As respostas de identidade são:

```ts
interface AuthIdentity {
  user: { id: string; name: string; email: string; roles: IdentityRole[]; orgId: string };
  org: { id: string; slug: string; name: string; kind: 'matraca' | 'partner' | 'backoffice';
    settings: Record<string, unknown>; branding: Record<string, unknown> };
}
```

Papéis disponíveis: `student`, `teacher`, `school`, `org_admin` e `operator`.
O realm `backoffice` exige exclusivamente `operator`; qualquer identidade com
esse papel fora do backoffice é recusada. Uma identidade estudante inserida
manualmente no backoffice também não consegue emitir ou usar um link de acesso.
O cadastro público não aceita papéis nem organização no corpo da requisição.

`requireIdentity` é a base de autenticação e papel; as fases escolares acrescentarão
as verificações de escola, turma, atribuição de professor e propriedade de cada
recurso. Um papel não concede acesso automático a todos os recursos de uma org.

## Fluxo de login

| Endpoint | Comportamento |
| --- | --- |
| `GET /api/context` | Retorna `{org}` pública do hostname cadastrado |
| `POST /api/auth/register` | Aceita apenas `{name,email}`; cadastra estudante convidado somente na org Matraca e prepara link local |
| `POST /api/auth/request` | Aceita apenas `{email}`; responde 202 genérico para existente, inexistente, suspenso ou limitado |
| `GET /api/auth/consume?token=...` | Consome token uma vez, ativa convidado, cria sessão nova e redireciona para `/app` ou `/backoffice` |
| `GET /api/auth/session` | Retorna `{user,org}` ou 401 |
| `POST /api/auth/logout` | Revoga sessão daquele host, limpa cookie e retorna 204; repetição é segura |

Cadastro em parceiro ou backoffice retorna 403: esses usuários precisam existir
como convidados ou ativos, por seed nesta fase e por gestão autorizada nas fases
seguintes. Cadastro repetido não altera nome, papéis nem status existentes.

Tokens e sessões são segredos de 32 bytes aleatórios, codificados em base64url.
O banco armazena somente SHA-256 desses valores. Tokens expiram após 15 minutos;
sessões, após sete dias. Host, org, propósito e usuário estão vinculados no banco.
Um link errado, expirado ou reutilizado redireciona para
`/login?error=invalid_link`, sem criar cookie. O token inválido não entra no destino
do redirecionamento e a resposta de consumo usa `Referrer-Policy: no-referrer`.

O consumo bloqueia as linhas de token e usuário na transação. Marcação de uso,
ativação do convidado, criação da sessão e auditoria são confirmadas juntas. Dois
consumos concorrentes do mesmo token não produzem duas sessões. Quando há uma
sessão anterior no mesmo host, ela é revogada na troca.

O cookie `matraca_session` usa `Path=/`, `HttpOnly`, `SameSite=Lax` e **não** tem
atributo `Domain`: é restrito ao host. `Secure` é ligado em HTTPS; o piloto local
usa HTTP. O backend também confere o hostname no registro da sessão, bloqueando
replay manual entre hosts mesmo quando ambos pertencem à mesma organização.

Mutações exigem `x-matraca-request: 1`. Se `Origin` vier presente, precisa coincidir
com protocolo e host da requisição. A aplicação não habilita CORS aberto. O header
customizado impede envio de formulário cross-site simples; a checagem de origem
também bloqueia requisições de outra organização.

Os limites são persistentes e atômicos: cinco pedidos por combinação e-mail/host
e cem pedidos por host a cada 15 minutos. Cadastro e pedido de login compartilham
os limites. Excesso mantém 202 e não gera novo token nem e-mail. As chaves desses
contadores são hashes, não endereços de e-mail em texto.

## E-mail simulado privado

Somente o transporte de e-mail é simulado. A aplicação não devolve tokens de login
em JSON e não oferece endpoint de inbox. Mensagens são arquivos JSON em
`dirname(STORAGE_ROOT)/mailbox/{orgId}/{uuid}.json`, normalmente `.data/mailbox`.
Pastas têm modo 0700 e arquivos, 0600. Tokens crus só aparecem no link desses
arquivos privados; cookies recebem apenas o segredo da sessão.

O link usa o hostname cadastrado e `APP_PUBLIC_PORT`, cujo padrão é **5173**.
Portas ou cabeçalhos encaminhados pelo cliente não escolhem o destino do link.
`APP_PUBLIC_PORT` aceita apenas inteiros de 1 a 65535. Nenhum provedor externo é
consultado e não existe prova real de que a pessoa controla o endereço informado.

Para abrir os links de demonstração no terminal local:

```sh
npx tsx scripts/inbox.ts --email ana@exemplo.test
npx tsx scripts/inbox.ts --email ana@exemplo.test --host parceiro.matraca.localhost
```

A CLI mostra até 20 mensagens recentes e pode incluir links já usados; seu consumo
continua protegido pelo banco. Ela não altera contas ou dados e não expõe um
servidor. Definir `STORAGE_ROOT` também muda a inbox para a pasta irmã, permitindo
testes isolados sem ler a caixa da demonstração.

O servidor frontend deve negar acesso HTTP a `.data`, ao armazenamento configurado
e à inbox. Permissões 0600 não substituem essa barreira porque o processo frontend
executa como o mesmo usuário do filesystem. Tokens não devem aparecer em logs de
requisição, tracing ou relatórios de teste. A aplicação local usa logger HTTP
desabilitado; ativá-lo futuramente exige redigir query e cabeçalhos sensíveis.

Se escrever a mensagem falhar, a transação de emissão é revertida. Se o commit
falhar, o arquivo gerado é removido; um encerramento abrupto entre arquivo e commit
pode deixar mensagem sem token válido, que será recusada. A entrega real futura
precisará de outbox e confirmação de envio próprios.

## Auditoria e limites da fase

`audit_events` registra criação de identidade, emissão de link, início e fim de
sessão. Registra ator, organização e hostname, sem token, cookie ou corpo do pedido.
O status do usuário ou da organização é revalidado na próxima requisição protegida.

A fase não implementa senha, SSO, MFA, serviço real de e-mail nem administração
completa de convites. A caixa local é um recurso de desenvolvimento, não mecanismo
de comprovação de e-mail para produção. Configuração produtiva permanece desabilitada.
`settings` e `branding` retornados por `/api/context` são públicos: segredos e
configurações privadas futuras deverão usar armazenamento separado.

## Validação

Testes de contrato e integração ficam em `tests/identity.test.ts`, com schema e
filesystem exclusivos. A evidência de execução e revisão da fase é consolidada
em `PHASE02_REVIEW.md`. Comandos de verificação:

```sh
npx vitest run tests/identity.test.ts
npx eslint server/auth.ts scripts/inbox.ts
npx tsc --noEmit
```

Referências: [Fastify decorators](https://fastify.dev/docs/latest/Reference/Decorators/),
[fastify-cookie](https://github.com/fastify/fastify-cookie) e
[OWASP: tokens de uso único e expiração](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html).
