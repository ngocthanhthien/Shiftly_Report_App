import {mkdirSync,copyFileSync,readFileSync} from 'node:fs';
import {Script} from 'node:vm';
const html=readFileSync('index.html','utf8');
new Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
mkdirSync('public',{recursive:true});
copyFileSync('index.html','public/index.html');
