import { fileURLToPath } from 'node:url';
import ui from '../../../../../../operator-web/vite.config.js';
const root=fileURLToPath(new URL('../../../../../../operator-web/',import.meta.url));
export default {...ui,root,test:{...ui.test,include:[fileURLToPath(new URL('./p04-review.spec.js',import.meta.url)).replaceAll('\\','/')],setupFiles:[fileURLToPath(new URL('../../../../../../operator-web/tests/setup.js',import.meta.url))]}};
