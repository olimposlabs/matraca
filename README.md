# Matraca

O Matraca ajuda a praticar oratória com uma trilha de estudo, gravações e avaliações por rubrica. O piloto atende alunos avulsos e organizações parceiras com identidade visual própria, escolas, professores e mentorias. Cada domínio tem contas e sessões independentes.

## Rodar o piloto

Use Node 24 LTS e inicie o Docker. Na pasta do projeto, execute:

```sh
npm ci
npm run dev
```

O comando inicia PostgreSQL local, aplica as migrações, confere o seed e sobe API e Vite. A API responde em `http://127.0.0.1:3001/api/health`. O volume do Docker preserva o banco, e os arquivos privados ficam em `.data/objects`.

| Área | Login | Personas |
| --- | --- | --- |
| Matraca direto | [Portal Matraca](http://matraca.localhost:5173/login) | `ana@exemplo.test`, `aluno2@matraca.test` a `aluno6@matraca.test` |
| Horizonte Oratória | [Portal parceiro](http://parceiro.matraca.localhost:5173/login) | `ana@exemplo.test`, `aluno2@parceiro.test` a `aluno6@parceiro.test` |
| Gestão do parceiro | [Login parceiro](http://parceiro.matraca.localhost:5173/login) | `admin@parceiro.test`, `escola@parceiro.test`, `professor1@parceiro.test` a `professor3@parceiro.test` |
| Backoffice | [Login do backoffice](http://backoffice.matraca.localhost:5173/login) | `operador@matraca.test` |

Solicite um link na tela e consulte a caixa de e-mail local. Use o host da tela de login, especialmente quando o e-mail existir nos dois portais.

```sh
npm run inbox -- --email ana@exemplo.test --host matraca.localhost
```

Abra o link retornado. Cada link é de uso único. Para testar compra e pagamento pela primeira vez com um aluno sem matrícula, crie um cadastro sintético no portal Matraca.

## Exemplos e ambiente de teste

```sh
npm run db:seed:examples
npm run pilot:sandbox -- start --name revisao --port 5174 --examples
```

O primeiro comando adiciona catálogo, compra simulada de aluno avulso, contrato, uma aula concluída com gravação e mentoria na escola parceira. O segundo cria um ambiente separado e também fecha uma competência de exemplo com relógio financeiro avançado. Para praticar um fechamento desde o início, omita `--examples` e configure o contrato na interface. Consulte a seção de sandbox para a caixa de e-mail e o reset. [Operações locais](docs/OPERATIONS.md)

A gravação, o progresso, a carteira, os pedidos e as faturas são persistidos. O feedback da IA, as transações financeiras e o e-mail são simulações locais. AWS e pipeline de deploy ficam para uma etapa posterior.

## Documentação

- [Roteiro do fundador](docs/GUIA_DO_PILOTO.md)
- [Plano e registro SPI](docs/EXECUCAO_SPI.md)
- [Plano de ensino](docs/PLANO_DE_ENSINO.md)
- [Créditos e faturamento](docs/CREDITOS_E_COBRANCA.md)
- [Arquitetura](docs/ARCHITECTURE.md)
- [Operações](docs/OPERATIONS.md)
- [Testes](docs/TESTING.md)
- [Diretrizes de engenharia](docs/ENGINEERING.md)
