# GPT-SoVITS-Fabric · fr-FR

| 当前键名 | 原对照表行号 | 应用文本 |
| --- | --- | --- |
| `glossary.terms.gpt_weights.detail` | L86 | Contrôle le rythme des pauses, la répartition de l'accentuation et les variations d'intonation, déterminant ainsi la prosodie de la voix synthétisée. Il convertit le texte en jetons sémantiques et détermine le phrasé, l’accentuation et le ton. C’est le fichier .ckpt du pack. |
| `glossary.terms.sovits_weights.detail` | L87 | Restitue les caractéristiques prosodiques avec le timbre et la texture acoustique du locuteur cible, déterminant la fidélité du timbre vocal. Il convertit les jetons sémantiques en forme d’onde et détermine le timbre. C’est le fichier .pth du pack. Les deux poids doivent être utilisés ensemble ; une paire incorrecte produit du bruit. |
| `msg.sep.no_request` | L101 | Paramètre de fichier de requête manquant |
| `msg.sep.empty_fields` | L102 | Le modèle, le chemin d'entrée et le chemin de sortie ne peuvent pas être vides |
| `msg.train.oom` | L104 | Mémoire vidéo (VRAM) insuffisante. Réduisez la taille de lot (Batch Size) ou fermez les autres applications utilisant la carte graphique avant de réessayer<br>Taille de lot actuelle: {batch} |
| `s.04c4e3b2b3` | L113 | Échec du téléchargement : {e} |
| `s.1455f353e7` | L115 | Échec de l'enregistrement du fichier : {e} |
| `s.703e6f531a` | L120 | Vérification et extraction d'archives volumineuses en cours ; le pourcentage exact ne peut pas être affiché à cette étape, veuillez patienter… |
| `s.7dc4ea39fd` | L124 | Le processus d'entraînement s'est arrêté sans renvoyer de résultat ; veuillez développer le journal en bas de page pour en rechercher la cause |
| `s.bc94a9c280` | L127 | Option avancée ; il est généralement recommandé de conserver la valeur par défaut |
| `s.provCoreDone` | L132 | Les composants essentiels sont installés. La synthèse vocale et l'entraînement de modèles sont maintenant opérationnels. |
| `s.9a79ee8bcd` | L136 | La reprise de téléchargement est prise en charge ; une nouvelle tentative reprendra à partir des données déjà reçues. |
| `s.errActDownload` | L137 | Aller aux téléchargements |
| `s.cleanupDataset` | L142 | Nettoyer les fichiers temporaires du jeu de données (segments découpés, transcriptions ASR et caches de caractéristiques) |
| `s.annot.dropChanges` | L150 | Vous avez des modifications non enregistrées. Voulez-vous vraiment les abandonner ? |
| `glossary.terms.prompt_text.detail` | L157 | Saisissez fidèlement le texte prononcé dans l'audio de référence ainsi que la ponctuation ; toute divergence peut entraîner des omissions de mots ou une altération du timbre. Il doit correspondre exactement à l’audio ; sinon le modèle interprète mal la prononciation et la voix devient instable. Les packs l’incluent déjà dans leurs fichiers .list. |
| `synth.pSpeedTip` | L160 | Une valeur supérieure à 1,0 accélère le débit, une valeur inférieure à 1,0 le ralentit ; un réglage trop extrême peut nuire au naturel de la voix. |
| `train.sepEntryDesc` | L172 | Lorsque vos enregistrements contiennent de la musique de fond ou un accompagnement, extrayez d'abord la voix pure ici avant de procéder au découpage et à l'entraînement. |
| `s.7f3ebfb67b` | L184 | Vous avez déjà synthétisé 10 pistes vocales ! GPT-SoVITS Fabric est entièrement gratuit — s'il vous est utile, n'hésitez pas à suivre le compte de Turing Mirror pour nous soutenir~ (Ce message ne s'affichera qu'une seule fois) |
