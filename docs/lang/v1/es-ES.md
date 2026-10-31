# GPT-SoVITS-Fabric · es-ES

| 当前键名 | 原对照表行号 | 应用文本 |
| --- | --- | --- |
| `glossary.terms.gpt_weights.detail` | L86 | Controla el ritmo de las pausas, la distribución de acentos y las variaciones de entonación, determinando la prosodia del habla sintetizada. Convierte el texto en tokens semánticos y determina las pausas, el acento y el tono. Es el archivo .ckpt del paquete. |
| `glossary.terms.sovits_weights.detail` | L87 | Convierte las características prosódicas en el timbre y la textura acústica del hablante objetivo, determinando la similitud de timbre de la voz sintetizada. Convierte los tokens semánticos en onda y determina el timbre. Es el archivo .pth del paquete. Ambos pesos deben usarse como pareja; una pareja incorrecta produce ruido. |
| `msg.sep.no_request` | L101 | Falta el parámetro del archivo de solicitud |
| `msg.sep.empty_fields` | L102 | El modelo, la ruta de entrada y la ruta de salida no pueden estar vacíos |
| `msg.train.oom` | L104 | Memoria de tarjeta gráfica insuficiente. Reduzca el tamaño de lote (Batch Size) o cierre otros programas que ocupen memoria gráfica e inténtelo de nuevo<br>Tamaño de lote actual: {batch} |
| `s.04c4e3b2b3` | L113 | Error de descarga: {e} |
| `s.1455f353e7` | L115 | Error al guardar el archivo: {e} |
| `s.703e6f531a` | L120 | Verificando y descomprimiendo archivos de componentes de gran tamaño; no es posible mostrar un porcentaje exacto en esta etapa, espere por favor… |
| `s.7dc4ea39fd` | L124 | El proceso de entrenamiento finalizó sin devolver resultados; despliegue el registro inferior para investigar la causa |
| `s.bc94a9c280` | L127 | Opción avanzada; por lo general se recomienda mantener el valor predeterminado |
| `s.provCoreDone` | L132 | Componentes esenciales instalados. Ya puede utilizar las funciones de síntesis de voz y entrenamiento de modelos. |
| `s.9a79ee8bcd` | L136 | Admite reanudación de descargas; al reintentar continuará desde la posición ya descargada. |
| `s.errActDownload` | L137 | Ir a descargas |
| `s.cleanupDataset` | L142 | Limpiar archivos temporales del conjunto de datos (fragmentos cortados, texto reconocido y caché de características) |
| `s.annot.dropChanges` | L150 | Hay cambios sin guardar. ¿Está seguro de que desea descartarlos? |
| `glossary.terms.prompt_text.detail` | L157 | Escriba con exactitud el texto real y los signos de puntuación correspondientes al audio de referencia; si el texto no coincide con el audio, pueden omitirse palabras o distorsionarse el timbre. Debe coincidir exactamente con el audio; de lo contrario, el modelo interpreta mal la pronunciación y la voz se vuelve inestable. Los paquetes ya lo incluyen en sus archivos .list. |
| `synth.pSpeedTip` | L160 | Valores mayores que 1,0 aceleran el habla y valores menores que 1,0 la ralentizan; un ajuste excesivo puede restar naturalidad a la voz. |
| `train.sepEntryDesc` | L172 | Cuando el material de entrenamiento contenga música de fondo o acompañamiento, separe primero aquí la voz limpia antes de pasar a la segmentación del conjunto de datos y al entrenamiento. |
| `s.7f3ebfb67b` | L184 | ¡Sin darte cuenta ya has sintetizado voz 10 veces! GPT-SoVITS Fabric es completamente gratuito; si te resulta útil, síguenos en las cuentas de Turing Mirror para apoyarnos~ (Este aviso solo se mostrará una vez) |
