# Brasil em relevo

Visualização tridimensional e interativa do território brasileiro e de seus 5.571 municípios distribuídos nas 27 Unidades da Federação, com relevo proporcional a indicadores socioeconômicos, demográficos e apurações eleitorais, renderizada com Three.js diretamente no navegador web.

## O que é

Uma aplicação interativa para exploração geográfica e estatística do Brasil e de seus estados em 3D. Na visão Brasil, todas as 27 Unidades Federativas são apresentadas com relevo proporcional e coloração temática. O usuário pode realizar drill-down sob demanda para qualquer estado da federação, explorando a totalidade dos seus municípios (como os 645 municípios de São Paulo, os 853 de Minas Gerais ou os 92 do Rio de Janeiro). Cada município ou unidade territorial é representado em três dimensões com altura proporcional ao indicador selecionado e coloração contínua ou por faixas quantílicas calculadas no espaço de cores OKLab. O sistema oferece modos temáticos e eleitorais com apuração em tempo real ou replay compacto.

## Navegação territorial e drill-down

A navegação territorial foi projetada para combinar velocidade, clareza espacial e controle pleno por teclado e mouse:

- **Visão Brasil:** Apresenta as 27 Unidades da Federação simultaneamente, com relevo proporcional aos totais agregados e paleta de cores temática ou partidária.
- **Drill-down por clique:** Clicar diretamente sobre qualquer estado no mapa tridimensional realiza a transição de câmera e carrega a malha municipal correspondente sob demanda.
- **Busca universal com sigla:** O campo de busca indexa todos os 5.571 municípios com suas respectivas siglas de estado (por exemplo: "Niterói, RJ", "Campinas, SP" ou "Belo Horizonte, MG"). Selecionar um município de outro estado aciona o drill-down automático para o território de destino com foco na unidade.
- **Breadcrumbs:** O cabeçalho exibe a trilha de navegação ("Brasil / Estado"), permitindo retornar à visão nacional com um clique no botão "Brasil".
- **Atalho pelo teclado (Esc):** Pressionar a tecla Esc na visão de estado detalhado fecha o território e retorna à visão Brasil, desde que não haja janelas modais abertas.

## Arquitetura e desempenho

O sistema foi concebido com foco em desempenho extremo e respeito rigoroso aos orçamentos de rede e memória:

- **Carga inicial estática leve:** O payload inicial estático da visão nacional completa soma menos de 150 KB transferidos, viabilizando inicialização rápida mesmo em conexões móveis restritas.
- **Drill-down sob demanda:** A geometria e os indicadores de cada estado são particionados de forma independente em [data/ufs/](data/ufs/). Ao selecionar um estado, o payload transferido permanece abaixo de 100 KB para a grande maioria das UFs, graças à quantização vetorial e compressão gzip.
- **Renderização em chamada única (BatchedMesh):** O motor Three.js renderiza a malha territorial utilizando um único draw call via `BatchedMesh`, otimizando a taxa de quadros e reduzindo expressivamente o consumo de VRAM em GPUs dedicadas ou integradas.
- **Desenho sob demanda:** Quando a câmera e os dados estão estacionários, o loop de renderização cessa a emissão de novos quadros, eliminando consumo desnecessário de CPU e bateria.
- **Separação estrita em quatro camadas:** Isolamento arquitetural determinístico entre `src/domain/` (lógica de negócios pura sem dependências), `src/engine/` (Three.js e shaders), `src/features/` (fatias verticais com interface e regras locais) e `src/app/` (composição e sincronização global).

## Captura

Abaixo estão as capturas oficiais em alta fidelidade da visão nacional e do detalhamento territorial:

![Visão Brasil com as 27 Unidades da Federação em relevo 3D](docs/captura-nacional.png)

![Drill-down detalhado dos municípios em relevo 3D](docs/captura-drilldown.png)

![Captura de tela do mapa 3D de São Paulo](docs/captura.png)

## Como rodar

O projeto utiliza JavaScript nativo em módulos ES e Three.js r185 via import map, sem necessidade de empacotamento ou transfiguração prévia.

1. Instale as dependências de desenvolvimento:
   ```bash
   npm install
   ```

2. Inicie o servidor local (gera os bundles antes de servir):
   ```bash
   npm start
   ```

3. Abra `http://localhost:4173` no navegador.

`npm run build` gera `dist/` a partir de `src/`, com imports dinâmicos preservados. Depois de editar o código, gere novamente os bundles antes de recarregar. Os comandos de teste também executam o build. A malha distribuída em gzip reconstrói o JSON original sem perda.

Para executar a suíte completa de testes:
```bash
npm run verify
```

## Decisões

As principais decisões de arquitetura e visualização adotadas no projeto:
- Renderização 3D em chamada única de desenho (`BatchedMesh`) para todos os municípios e estados, com desenho sob demanda (zero quadros ociosos quando parado).
- Separação estrita em quatro camadas (`src/domain/`, `src/engine/`, `src/features/` e `src/app/`), sem dependências externas além do Three.js.
- Escala logarítmica geométrica de 7 faixas para municípios e quantis de 7 faixas para as 16 regiões administrativas, com paleta em espaço perceptivo OKLab.
- Navegação nacional com suporte a todas as 27 UFs e 5.571 municípios com drill-down sob demanda.
- Dados pré-processados a partir das bases oficiais em [data/](data/) e recursos visuais em [docs/](docs/).

## Fontes

Os dados utilizados neste projeto provêm de fontes oficiais públicas:

- **IBGE (Instituto Brasileiro de Geografia e Estatística)**
  - Malha Municipal Digital (2022): [https://www.ibge.gov.br/geociencias/organizacao-do-territorio/malhas-territoriais/15774-malhas.html](https://www.ibge.gov.br/geociencias/organizacao-do-territorio/malhas-territoriais/15774-malhas.html)
  - Censo Demográfico (2022), População residente: [https://www.ibge.gov.br/estatisticas/sociais/populacao/22827-censo-demografico-2022.html](https://www.ibge.gov.br/estatisticas/sociais/populacao/22827-censo-demografico-2022.html)
  - Produto Interno Bruto dos Municípios (2023): [https://www.ibge.gov.br/estatisticas/economicas/contas-nacionais/9088-produto-interno-bruto-dos-municipios.html](https://www.ibge.gov.br/estatisticas/economicas/contas-nacionais/9088-produto-interno-bruto-dos-municipios.html)

- **Fundação Seade (Sistema Estadual de Análise de Dados)**
  - Municípios e Regiões Administrativas do Estado de São Paulo (2026): [https://www.seade.gov.br](https://www.seade.gov.br)

## Atribuição dos dados

Os dados vêm de fontes públicas. Cada uma é citada abaixo, com link e data de acesso.

A condição de licença de cada fonte está no `meta` dos arquivos de `data/`.

### IBGE

- **Malha municipal.** IBGE, Malha Municipal, 2022. [Página do produto](https://www.ibge.gov.br/geociencias/organizacao-do-territorio/malhas-territoriais/15774-malhas.html). Acesso em 16/10/2026. O IBGE libera a malha sob licença compatível com CC BY 4.0, com crédito. Condições de uso: [Notas metodológicas 01/2026](https://biblioteca.ibge.gov.br/visualizacao/livros/liv102268.pdf).
- **Censo Demográfico 2022.** IBGE, SIDRA, tabela 4714, 2022. [Tabela no SIDRA](https://sidra.ibge.gov.br/tabela/4714). Acesso em 16/10/2026.
- **PIB dos Municípios 2023.** IBGE, SIDRA, tabela 5938, 2023. [Tabela no SIDRA](https://sidra.ibge.gov.br/tabela/5938). Acesso em 16/10/2026.

Aviso sobre a malha: este projeto a processou, com projeção e quantização, e ela mudou de característica em relação à original. Os limites são aproximados e não oficiais.

### Fundação Seade

- **Municípios do Estado de SP.** Fundação Seade, Municípios do Estado de SP, 2026. Composição das 16 regiões administrativas e seus rótulos. [Conjunto de dados](https://repositorio.seade.gov.br/dataset/1617c335-f5ab-426c-b175-280d4e41ec1c). Acesso em 16/10/2026.

## Licença

Distribuído sob licença MIT. Copyright (c) 2026 Manoel Osmi.
