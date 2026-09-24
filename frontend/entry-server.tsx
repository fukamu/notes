import { renderToString } from 'react-dom/server';
import {
  baseDescription,
  publicRoutes,
  RouteApplication,
  routeTitle,
} from './routes';

export type PrerenderedRoute = Readonly<{
  pathname: string;
  title: string;
  description: string;
  markup: string;
}>;

export function prerender(pathname: string): PrerenderedRoute {
  return {
    pathname,
    title: routeTitle(pathname),
    description: baseDescription,
    markup: renderToString(<RouteApplication pathname={pathname} />),
  };
}

export function publicRoutePaths(): string[] {
  return Object.keys(publicRoutes).sort();
}
