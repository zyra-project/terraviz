# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The Zyra Project

import json
import sys

from qgis.core import QgsApplication, QgsVectorLayer, Qgis

root, collection = sys.argv[1:3]
application = QgsApplication([], False)
application.initQgis()
try:
    layer = QgsVectorLayer(f"url='{root}' typename='{collection}'", "STAC Items", "OAPIF")
    assert layer.isValid(), layer.error().message()
    features = list(layer.getFeatures())
    assert len(features) == 120, f"Expected 120 features, received {len(features)}"
    assert all(feature.hasGeometry() for feature in features)
    assert layer.crs().isGeographic()
    print(json.dumps({"qgis": Qgis.QGIS_VERSION, "provider": layer.providerType(), "features": len(features)}))
    del features
    del layer
finally:
    application.exitQgis()