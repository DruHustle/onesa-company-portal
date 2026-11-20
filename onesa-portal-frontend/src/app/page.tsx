import CompanyLayout, {generateMetadata as publicationMetadata} from './[locale]/layout';
import CompanyHome from './[locale]/page';
import {homepageMetadata} from '@/lib/metadata';
export async function generateMetadata() {
  return {...homepageMetadata(), ...await publicationMetadata()};
}
export default function Home() {
  const params = Promise.resolve({locale: 'en' as const});
  return <CompanyLayout params={params}><CompanyHome params={params}/></CompanyLayout>;
}
