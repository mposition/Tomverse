/**
 * Words for what an answer shows around its text: inline charts, the credits
 * an answer actually cost, and branching a conversation from an answer.
 *
 * A side table keyed by language (the shape locales/chatTurnTools.ts uses) so
 * these screens do not share a merge hot spot with the large locale files.
 */
import type { Language } from "@/lib/language";

export type ChatAnswerSurfaceCopy = {
  chartBar: string;
  chartLine: string;
  chartArea: string;
  chartPie: string;
  chartScatter: string;
  chartShowData: string;
  chartCategory: string;
  chartSeries: string;
  chartValue: string;
  chartShare: string;
};

export const chatAnswerSurfaceCopy: Record<Language, ChatAnswerSurfaceCopy> = {
  en: {
    chartBar: "Bar chart",
    chartLine: "Line chart",
    chartArea: "Area chart",
    chartPie: "Pie chart",
    chartScatter: "Scatter plot",
    chartShowData: "Show the data as a table",
    chartCategory: "Category",
    chartSeries: "Series",
    chartValue: "Value",
    chartShare: "Share",
  },
  ko: {
    chartBar: "막대 차트",
    chartLine: "선 차트",
    chartArea: "영역 차트",
    chartPie: "원형 차트",
    chartScatter: "산점도",
    chartShowData: "데이터를 표로 보기",
    chartCategory: "항목",
    chartSeries: "계열",
    chartValue: "값",
    chartShare: "비율",
  },
  zh: {
    chartBar: "柱状图",
    chartLine: "折线图",
    chartArea: "面积图",
    chartPie: "饼图",
    chartScatter: "散点图",
    chartShowData: "以表格查看数据",
    chartCategory: "类别",
    chartSeries: "系列",
    chartValue: "数值",
    chartShare: "占比",
  },
  "zh-Hant": {
    chartBar: "長條圖",
    chartLine: "折線圖",
    chartArea: "面積圖",
    chartPie: "圓餅圖",
    chartScatter: "散佈圖",
    chartShowData: "以表格檢視資料",
    chartCategory: "類別",
    chartSeries: "數列",
    chartValue: "數值",
    chartShare: "占比",
  },
  fr: {
    chartBar: "Diagramme à barres",
    chartLine: "Courbe",
    chartArea: "Graphique en aires",
    chartPie: "Graphique circulaire",
    chartScatter: "Nuage de points",
    chartShowData: "Afficher les données sous forme de tableau",
    chartCategory: "Catégorie",
    chartSeries: "Série",
    chartValue: "Valeur",
    chartShare: "Part",
  },
  de: {
    chartBar: "Balkendiagramm",
    chartLine: "Liniendiagramm",
    chartArea: "Flächendiagramm",
    chartPie: "Kreisdiagramm",
    chartScatter: "Streudiagramm",
    chartShowData: "Daten als Tabelle anzeigen",
    chartCategory: "Kategorie",
    chartSeries: "Reihe",
    chartValue: "Wert",
    chartShare: "Anteil",
  },
  es: {
    chartBar: "Gráfico de barras",
    chartLine: "Gráfico de líneas",
    chartArea: "Gráfico de áreas",
    chartPie: "Gráfico circular",
    chartScatter: "Diagrama de dispersión",
    chartShowData: "Mostrar los datos como tabla",
    chartCategory: "Categoría",
    chartSeries: "Serie",
    chartValue: "Valor",
    chartShare: "Proporción",
  },
  pt: {
    chartBar: "Gráfico de barras",
    chartLine: "Gráfico de linhas",
    chartArea: "Gráfico de área",
    chartPie: "Gráfico de pizza",
    chartScatter: "Gráfico de dispersão",
    chartShowData: "Mostrar os dados como tabela",
    chartCategory: "Categoria",
    chartSeries: "Série",
    chartValue: "Valor",
    chartShare: "Proporção",
  },
};
