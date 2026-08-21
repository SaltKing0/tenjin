export interface TableCell {
  tag: string;
  text?: string;
}

export function headerLabels(firstRow: TableCell[] | null | undefined): string[];
export function stackLabels(
  headers: string[],
  cells: TableCell[],
): Array<string | undefined>;
export function isHeaderRow(row: TableCell[]): boolean;
