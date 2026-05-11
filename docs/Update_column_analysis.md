### `SAM_DATA` schema

| Table                       | Used in                                                                                                                  | Update column name |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| `ADDRESS`                   | find-customers                                                                                                           | UPDATED_DATETIME   |
| `ADDRESS_USAGE`             | find-customers                                                                                                           | UPDATED_DATETIME   |
| `ALT_PARTY_IDENTITY`        | find-customers                                                                                                           | UPDATED_DATETIME   |
| `ANIMAL`                    | find-locations                                                                                                           | UPDATED_DATETIME   |
| `ANIMAL_SPECIES`            | find-locations                                                                                                           | UPDATED_DATETIME   |
| `ASSET`                     | find-locations                                                                                                           | UPDATED_DATETIME   |
| `ASSET_LOCATION`            | find-locations, get-location                                                                                             | UPDATED_DATETIME   |
| `ASSET_STATE`               | find-locations                                                                                                           | UPDATED_DATETIME   |
| `BS7666_ADDRESS`            | find-customers, find-locations                                                                                           | UPDATED_DATETIME   |
| `COLL_REGSTRD_ANIMAL_GROUP` | find-locations                                                                                                           | UPDATED_DATETIME   |
| `CPH`                       | find-holding, find-holdings                                                                                              | UPDATED_DATETIME   |
| `FACILITY`                  | find-locations, get-location                                                                                             | UPDATED_DATETIME   |
| `FACILITY_BUSINESS_ACTIVTY` | find-locations                                                                                                           | UPDATED_DATETIME   |
| `FACILITY_TYPE`             | find-locations                                                                                                           | UPDATED_DATETIME   |
| `FEATURE`                   | find-locations, get-location                                                                                             | UPDATED_DATETIME   |
| `FEATURE_ADDRESS`           | find-locations                                                                                                           | UPDATED_DATETIME   |
| `FEATURE_INVOLVEMENT`       | find-holding, find-holdings, find-locations                                                                              | UPDATED_DATETIME   |
| `FEATURE_POINT`             | find-locations                                                                                                           | UPDATED_DATETIME   |
| `FEATURE_STATE`             | find-holding, find-holdings, find-locations                                                                              | UPDATED_DATETIME   |
| `LIVESTOCK_UNIT`            | find-locations, get-location                                                                                             | UPDATED_DATETIME   |
| `LOCATION`                  | find-holding, find-holdings, find-locations, get-location                                                                | UPDATED_DATETIME   |
| `ORGANISATION`              | find-customers, get-customer-types                                                                                       | UPDATED_DATETIME   |
| `PARTY`                     | find-customers, find-holding, find-holdings, get-customer-types                                                          | UPDATED_DATETIME   |
| `PARTY_CONTACT_ADDRESS`     | find-customers                                                                                                           | UPDATED_DATETIME   |
| `PARTY_ROLE`                | find-holding, find-holdings                                                                                              | UPDATED_DATETIME   |
| `PARTY_STATE`               | find-customers, find-holding, find-holdings, get-customer-types                                                          | UPDATED_DATETIME   |
| `PARTY_VERSION`             | find-customers, get-customer-types                                                                                       | UPDATED_DATETIME   |
| `PERSON`                    | find-customers, get-customer-types                                                                                       | UPDATED_DATETIME   |
| `REF_DATA_CODE`             | find-customers, find-holding, find-holdings, find-locations, get-purpose-species-code-mapping, get-workarea-code-mapping | UPDATED_DATETIME   |
| `REF_DATA_CODE_DESC`        | find-customers, find-holding, find-holdings, find-locations, get-purpose-species-code-mapping, get-workarea-code-mapping | UPDATED_DATETIME   |
| `REF_DATA_CODE_MAP`         | find-holding, find-holdings                                                                                              | UPDATED_DATETIME   |
| `REF_DATA_SET`              | find-customers, find-locations, get-purpose-species-code-mapping, get-workarea-code-mapping                              | UPDATED_DATETIME   |
| `REF_DATA_SET_MAP`          | find-holding, find-holdings                                                                                              | UPDATED_DATETIME   |
| `TELECOM_ADDRESS`           | find-customers                                                                                                           | UPDATED_DATETIME   |

### `PEGA_DATA` schema

| Table                   | Used in                         | Update column name           |
| ----------------------- | ------------------------------- | ---------------------------- |
| `ahwork_ac`             | find-workorders, get-workorders | PXUPDATEDATETIME             |
| `index_ac_activity`     | find-workorders, get-workorders | PXUPDATEDATETIME always null |
| `index_ac_workschedule` | find-workorders, get-workorders | PXUPDATEDATETIME always null |
| `index_ac_wsentities`   | find-workorders, get-workorders | PXUPDATEDATETIME always null |
| `pr_operators`          | find-workorders, get-workorders | PXUPDATEDATETIME             |
