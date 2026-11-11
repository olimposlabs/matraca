# Revisão do backend de cursos — F06

Revisão independente do código inicial feita antes da integração final da interface: `course-model.ts`, `courses.ts`, `course-assets.ts`, `http-media.ts`, migração006 e `seed-courses.ts`. O revisor passou a implementar correções pontuais após autorização do responsável pela fase; a revisão final do conjunto continua necessária.

## Achados e correções

| Achado observado | Evidência anterior à correção | Comportamento corrigido e regressão |
| --- | --- | --- |
| Republicação idêntica não retirava o curso do estado arquivado | Teste HTTP publicou, arquivou e republicou; a API devolveu a versão, mas o estado continuou `archived` | Publicação idêntica mantém o snapshot e repõe `published`; teste passa sem criar nova versão |
| Matrícula cancelada conservava acesso de aluno | Teste HTTP listou a matrícula `cancelled`; inspeção confirmou ausência do filtro também no detalhe e nos anexos | Listagem e detalhe do aluno excluem canceladas; download também exige matrícula não cancelada. Teste confirma revogação e preservação do acesso após conclusão |
| Imagem truncada era aceita como material | PNG sintético de70 bytes passou leitura de metadados, falhou na decodificação e recebeu HTTP201 no upload | Decodificação integral limitada antes do registro. O mesmo arquivo recebe400 e não conserva objeto ou registro |
| Ingressante recebia a primeira versão atribuída à turma | Depois de atribuir v1 e v2, teste pela matrícula escolar recebeu v1 para novo aluno | Seleção usa a versão de maior número atribuída a cada curso; matrícula anterior mantém v1 e novo aluno recebe v2 |

A inspeção também identificou que o vínculo à turma propagava cursos arquivados. O filtro de curso publicado impede essa propagação; o teste inclui um novo aluno após o arquivamento e verifica ausência de matrícula, mantendo acesso do aluno antigo. Esse ramo foi verificado após a correção, sem alegar falha executada antes dela.

## Controles examinados

Tenant e papéis são verificados no servidor. As mutações serializam a organização e revalidam a sessão depois da espera; publicação usa revisão otimista e snapshots protegidos contra atualização/exclusão. FKs compostas impedem atribuir versão, aluno, turma ou anexo de outra organização. Copiar a base cria objetos e IDs próprios, sem autorizar referência direta a anexos de outro curso.

Materiais pendentes só são acessíveis ao editor; o aluno recebe somente anexos citados na versão em que está matriculado. Downloads usam streaming com faixa única, validação de limites, `nosniff`, `no-store` e CSP restritiva. PDFs recebem verificação estrutural mínima de assinatura/trailer; não se afirma validação completa de páginas. Arquivos de mídia passam pelo parser de pacotes. Falha de upload/validação remove o objeto criado antes do registro.

## Evidência de execução

Após as correções, `tests/courses.test.ts`, `tests/curriculum.test.ts` e `tests/education.test.ts` passaram:38 testes. Typecheck e lint dos arquivos modificados passaram. Os testes usam PostgreSQL com schema isolado e diretório temporário de objetos; não modificam a demonstração.

Esta revisão não declara concluídos editor visual, E2E, integração deF05, jornadas/recompensas, pagamentos ou avaliação por IA. A migração006 não foi alterada nesta revisão. Nenhum novo bloqueio foi identificado no escopo examinado; os gates finais pertencem à integração da fase.
