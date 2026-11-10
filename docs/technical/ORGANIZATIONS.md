# Organizações e branding — F03

`registerOrganizations(app)` em `server/organizations.ts` registra provisionamento,
configuração e branding. A identidade por host continua em `server/auth.ts`.
A migração `003_branding.sql` cria histórico e assets de logo, além de completar
a marca inicial das organizações existentes.

## Acesso e provisionamento

Operações centrais exigem sessão `operator` na organização `backoffice`.
Operações de `/api/org/*` exigem `org_admin`; o alvo vem exclusivamente da
identidade validada no servidor. Um campo `orgId` enviado no corpo é inválido.
Professor, aluno e gestor de escola não podem editar a configuração da organização.

| Verbo e caminho | Corpo e resultado |
| --- | --- |
| `GET /api/backoffice/orgs` | `{orgs: OrgView[]}` |
| `POST /api/backoffice/orgs` | `{name,slug,adminName,adminEmail}` → 201, `{org,brandingHistory,admin,portalUrl}` |
| `GET /api/backoffice/orgs/:id` | `{org,brandingHistory}` da organização indicada |
| `PATCH /api/backoffice/orgs/:id` | `{name?,status?,settings?}` → `{org,brandingHistory}` |
| `GET /api/org/manage` | `{org,brandingHistory}` da organização da sessão |
| `PATCH /api/org/settings` | Patch de flags permitidas → `{org,brandingHistory}` |
| `PUT /api/org/branding` | `{branding,expectedRevision}` → `{org,brandingHistory}` |
| `POST /api/org/branding/restore` | `{revision,expectedRevision}` → `{org,brandingHistory}` |
| `POST /api/org/logo` | Multipart com um campo `file` → 201, `{logoKey,contentType,width,height,bytes}` |
| `GET /api/branding/logo` | Imagem ativa da organização do hostname; rota pública intencional |

As rotas centrais equivalentes para publicar/restaurar logo e marca são
`PUT /api/backoffice/orgs/:id/branding`,
`POST /api/backoffice/orgs/:id/branding/restore` e
`POST /api/backoffice/orgs/:id/logo`.

`OrgView` contém `id`, `slug`, `name`, `kind`, `status`, `settings`, `branding`,
`hostname`, `portalUrl` e `userCount`. O histórico retorna até 100 revisões recentes,
com `revision`, `branding`, `createdAt` e `actorId`; versões mais antigas continuam
no banco e podem ser restauradas pelo número. E-mail, nome e perfil de um operador
central não são expostos no histórico de outro tenant.

Criar um parceiro é uma transação única: organização `partner`, domínio
`{slug}.matraca.localhost`, administrador `org_admin` convidado, snapshot inicial
da marca e auditoria. O administrador solicita seu link de acesso no novo host;
essa criação não envia e-mail real nem gera link de login automaticamente.
`portalUrl` usa a porta pública configurada em `APP_PUBLIC_PORT`, padrão 5173.

Slugs têm de 3 a 40 caracteres ASCII minúsculos, números e hífens internos.
Identificadores de infraestrutura como `matraca`, `backoffice`, `www`, `api`,
`admin`, `auth` e `assets` são reservados. Colisões de slug ou domínio retornam
409, sem organização incompleta. O cadastro não permite escolher papéis, kind,
domínio arbitrário ou ID. Renomear a organização não altera seu slug/domínio nem
o texto de branding já publicado. A interface central não pode suspender o
backoffice e bloquear o próprio acesso.

## Settings

O patch aceita exclusivamente booleanos `coursesEnabled`, `strictJourney`,
`leaderboardEnabled` e `diagnosticEnabled`. Pelo menos um campo deve ser informado.
Configurações anteriores são preservadas; o patch só altera as flags enviadas.
O servidor bloqueia a linha da organização antes da atualização para preservar
patches concorrentes de campos diferentes.

Os padrões são cursos, ranking e diagnóstico habilitados, com jornada obrigatória
desabilitada. As fases posteriores implementarão os módulos que consomem essas
flags; persistir a flag nesta fase não significa que o módulo futuro já exista.

## Publicação e restauração

Branding é um objeto completo e estrito:

```ts
interface BrandingInput {
  displayName: string; // 1–80 caracteres
  primary: string; background: string; surface: string; text: string; muted: string;
  font: 'sans' | 'serif';
  creditSingular: string; // 1–32 caracteres
  creditPlural: string; // 1–40 caracteres
  logoKey?: string;
}
```

Rótulos são texto simples, sem HTML ou controles. Cores são somente HEX de seis
dígitos. Não são aceitos CSS, URLs, fontes remotas, SVG ou `_revision` no objeto
enviado pelo cliente. Para remover um logo, publique o objeto sem `logoKey`.

`text` e `muted` precisam ter contraste mínimo de 4,5:1 sobre `background` **e**
`surface`. `primary` precisa atingir 4,5:1 contra branco, usado no texto dos botões.
A validação segue a fórmula de luminância relativa de WCAG; combinações inválidas
retornam 400 antes de persistir. Isso valida as combinações configuráveis, não é
uma certificação automática de acessibilidade de toda a interface.

Padrões: primary `#b8442b`, background `#faf8f2`, surface `#ffffff`, text `#1f2925`,
muted `#59665f`, fonte `sans` e crédito/créditos. A migração ajusta o primary antigo
do seed, `#c95032` (aproximadamente 4,49:1 sobre branco), para `#b8442b` (5,38:1).

O servidor controla `branding._revision`, inicialmente zero. A transação de
publicação bloqueia `orgs`, confere `expectedRevision`, valida a propriedade do
logo e grava marca, snapshot e auditoria juntos. Concorrência com revisão antiga
retorna 409 e preserva a publicação vencedora. O preview do editor permanece no
navegador; só uma publicação válida altera o JSON persistido.

Restauração consulta `org_branding_history` por **org e revisão**, valida a marca
histórica e publica uma revisão nova. Não apaga o histórico nem reutiliza o número
antigo. Se a versão 3 restaurar a versão 1, a nova versão será 4. O logo histórico
também precisa pertencer à organização; assets anteriores permanecem disponíveis
para restauração.

## Logos

Uploads precisam corresponder em MIME e assinatura a PNG, JPEG ou WebP, ter até
2 MiB, ser estáticos e ter até 4096 pixels por dimensão e 16 milhões de pixels.
`sharp` decodifica a imagem com limites e falhas de decodificação são recusadas.
O resultado é recodificado em WebP, sem os metadados do original, com no máximo
1024×1024 pixels e preservação da proporção. Imagens menores não são ampliadas.

O nome de arquivo enviado não compõe o caminho de armazenamento. O servidor gera
`branding/{orgId}/{uuid}` e salva no armazenamento privado. `logo_assets` registra
organização, tipo, dimensões, bytes e autor. O upload não publica o asset nem muda
a revisão da marca; a publicação posterior inclui `logoKey` e passa pelo controle
de concorrência. Um upload nunca pode ativar um asset de outra organização.

`GET /api/branding/logo` não aceita org, caminho ou chave no parâmetro. Obtém somente
o logo publicado da organização ativa do hostname. Retorna `image/webp`,
`X-Content-Type-Options: nosniff`, disposição inline e CSP restritiva. Um logo
não publicado ou ausente retorna 404. Não há rota pública de listagem ou leitura
arbitrária do armazenamento; sua barreira HTTP continua válida.

MIME/assinatura incompatível retorna 415; arquivo corrompido ou dimensões inválidas,
400; excesso de tamanho, 413. Se persistir o registro falhar depois de gravar o
arquivo, a rotina remove o asset novo. Um encerramento abrupto pode deixar arquivo
órfão privado; a reconciliação operacional de storage será tratada na fase 13.

## Auditoria e validação

O histórico possui FK simples de `actor_user_id` para `users(id)`: um operador do
backoffice pode modificar uma marca de parceiro sem falsificar sua organização.
A auditoria central é registrada na organização do operador, com `targetOrgId`
e revisão em metadata. Ações do administrador ficam na sua própria organização.
Não há propagação de dados pessoais entre tenants.

Testes independentes estão em `tests/organizations.test.ts`; a revisão da fase
consolida evidências em `PHASE03_REVIEW.md`. Comandos pertinentes:

```sh
npx vitest run tests/organizations.test.ts
npx eslint server/organizations.ts
npx tsc --noEmit
```

Referências verificadas: [limites de entrada do sharp](https://sharp.pixelplumbing.com/api-constructor/),
[saída e metadados do sharp](https://sharp.pixelplumbing.com/api-output/),
[multipart Fastify](https://github.com/fastify/fastify-multipart) e
[contraste WCAG](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html).

O domínio é roteado localmente; DNS público, infraestrutura AWS e envio real de
e-mail não são provisionados por esses endpoints. A validação do logo comprova
o comportamento no runtime Node local, não compatibilidade automática de builds
nativos em qualquer ambiente de produção.
