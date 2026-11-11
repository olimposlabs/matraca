# F03 — revisão de organizações e branding

Revisão interna independente das APIs de provisionamento, configurações, publicação de marca e logos. Não encerra os gates externos da fase nem comprova as funcionalidades de cursos, avaliações ou faturamento previstas para fases seguintes.

## Escopo

Foram examinados `server/organizations.ts`, `server/migrations/003_branding.sql`, o registro das rotas em `server/app.ts` e o comportamento observado por [organizations.test.ts](../../tests/organizations.test.ts).

A suíte usa schema PostgreSQL aleatório, pools com `search_path` restrito e storage/mailbox em diretório temporário. Todas as organizações, usuários, sessões e imagens são sintéticos. O cleanup remove apenas o schema e o diretório pertencentes à execução, preservando a demonstração local.

## Evidências locais

Execução em Node `24.22.2`, Vitest `4.1.12` e PostgreSQL 17: **31 testes passaram, sem skips**. Lint da suíte, `tsc --noEmit` e `git diff --check` passaram.

| Área | Comportamento verificado |
| --- | --- |
| Provisionamento | Operador no backoffice lista e cria organização; administrador do parceiro não possui essa permissão |
| Continuidade do backoffice | Tentativa de suspender a própria organização retorna `400`; organização permanece ativa e a sessão do operador continua funcional |
| Novo parceiro | Criação estabelece domínio canônico `slug.matraca.localhost`, administrador convidado, login pelo link da mailbox e sessão própria |
| Validação | Slugs reservados ou malformados são rejeitados; colisão retorna `409` sem administrador órfão |
| Escopos | Administrador de um parceiro não usa a API central para consultar ou editar outro; operador consegue executar a operação central autorizada |
| Papéis | Aluno, professor e gestor escolar não editam branding/configuração da organização nem enviam logo |
| Identidade do parceiro | Alteração central não aceita mudanças de slug ou tipo da organização |
| Configurações | Quatro flags aceitas persistem; campos desconhecidos são rejeitados; alterações não atingem outro tenant |
| Publicação | Branding persiste no banco, reaparece no contexto público após recriar a aplicação e permanece isolado por organização |
| Histórico | Restore cria revisão nova preservando a anterior; tentativa com revisão desatualizada retorna `409` |
| Concorrência | Duas publicações com a mesma revisão geram exatamente um `200` e um `409`, com uma revisão adicional no histórico |
| Validação visual | CSS, URL em cor/fonte, campos extras, revisão fornecida dentro do branding e cores sem contraste são rejeitados |
| Logos válidos | PNG, JPEG e WebP sintéticos são aceitos e normalizados para WebP; imagem PNG acima de 1 MiB e abaixo de 2 MiB também é aceita |
| Logos inválidos | SVG, conteúdo disfarçado, PNG truncado, MIME incompatível e arquivo acima de 2 MiB são rejeitados sem registros de assets |
| Publicação de logo | Upload prepara o asset sem publicar nem alterar revisão; publicação posterior ativa a imagem pública no host correto |
| Isolamento de logo | Outro parceiro não publica asset alheio; contexto sem logo ou organização suspensa retorna `404`; imagem entregue tem `nosniff` |

## Revisão dos controles

As rotas do parceiro obtêm a organização da sessão validada no servidor. As rotas centrais exigem papel `operator` no contexto de backoffice antes de aceitar um ID de destino. A criação de organização, domínio, administrador, histórico inicial e auditoria ocorre em uma transação; conflitos de unicidade são tratados sem criar registros parciais.

Publicação e restauração bloqueiam a linha da organização, comparam `expectedRevision` e registram a nova revisão na mesma transação. O histórico mantém o ator, inclusive quando um operador de outra organização executa a administração central. A auditoria registra esse ator no seu contexto e identifica a organização de destino nos metadados.

Uploads exigem assinatura binária compatível com o MIME permitido e decodificação completa. O processamento limita entrada a 2 MiB, 16 milhões de pixels, 4096 pixels por dimensão e imagem estática; a saída é WebP com até 1024 pixels por dimensão. A chave de armazenamento é gerada no servidor, vinculada à organização e conferida novamente na publicação. O endpoint público seleciona o asset publicado pelo contexto do host, sem aceitar chave arbitrária do cliente.

Não foram identificados achados bloqueantes pendentes nesse escopo. A suíte não substitui validação visual da interface; as evidências de navegação, preview e acessibilidade pertencem à inspeção do frontend.

## Limites e gates

Flags foram verificadas como configuração persistente. A existência de `coursesEnabled`, por exemplo, não comprova o funcionamento do curso das fases posteriores. Assets preparados e não publicados permanecem no armazenamento; não foi implementada nem validada uma rotina de descarte desses assets nesta fase.

CI remota, revisão GitHub Codex Review ou mecanismo substituto aprovado, SHA final e merge permanecem **Não confirmados** neste relatório. Nenhuma aprovação externa é inferida da aprovação dos testes locais.
