// Genera un token para un equipo y la sentencia SQL que guarda SOLO su hash.
//   node scripts/token-equipo.mjs linea-1
import { createHash, randomBytes } from 'node:crypto'

const equipo = process.argv[2]
if (!equipo || !/^[a-z0-9_-]+$/i.test(equipo)) {
  console.error('Uso: node scripts/token-equipo.mjs <id-del-equipo>   (ej: linea-1)')
  process.exit(1)
}
const token = randomBytes(24).toString('base64url')        // 32 caracteres
const hash = createHash('sha256').update(token).digest('hex')

console.log(`
1) Pega este token en contador_eg118.ino (EQUIPO_TOKEN). Guárdalo en un lugar seguro:
   no se puede recuperar desde la base de datos.

   const char* EQUIPO_TOKEN = "${token}";

2) Ejecuta esto en Supabase → SQL Editor (guarda solo el hash):

   insert into public.equipos (id, nombre) values ('${equipo}', '${equipo}') on conflict (id) do nothing;
   update public.equipos set token_hash = '${hash}' where id = '${equipo}';

3) Para probar la función desde el PC:

   curl -X POST "https://<ref>.supabase.co/functions/v1/ingesta" \\
        -H "Content-Type: application/json" -H "x-equipo-token: ${token}" \\
        -d '[{"seq":1,"tipo":"inicio","n":0}]'
`)
