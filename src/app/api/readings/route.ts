import { handleChartSave } from "@/readings/chart-save";

export async function POST(request: Request) { return handleChartSave(request); }
