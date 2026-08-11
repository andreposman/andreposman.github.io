import { en } from './en';
import { ptBR } from './pt-br';

const dicts = { en, 'pt-br': ptBR };
type Dict = typeof en;

export function t(locale: string | undefined): Dict {
	return dicts[locale as keyof typeof dicts] ?? en;
}
