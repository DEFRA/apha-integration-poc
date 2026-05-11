# index_ac Table Mapping (Simplified)

| Table                 | Field                                 | Response Field                                            |
| --------------------- | ------------------------------------- | --------------------------------------------------------- |
| index_ac_workschedule | pyid                                  | workorders[].id                                           |
| index_ac_workschedule | purposeworkarea                       | workorders[].workArea                                     |
| index_ac_workschedule | purposecountry                        | workorders[].country                                      |
| index_ac_workschedule | aimname                               | workorders[].aim                                          |
| index_ac_workschedule | businessarea                          | workorders[].businessArea                                 |
| index_ac_workschedule | purposename                           | workorders[].purpose                                      |
| index_ac_workschedule | speciesforpurpose                     | workorders[].species                                      |
| index_ac_workschedule | phase                                 | workorders[].phase                                        |
| index_ac_wsentities   | entityid (workScheduleLocation)       | workorders[].relationships.location.data.id               |
| index_ac_wsentities   | cphid (workScheduleLocation)          | workorders[].relationships.holding.data.id                |
| index_ac_wsentities   | entityid (workScheduleCustomers)      | workorders[].relationships.customerOrOrganisation.data.id |
| index_ac_wsentities   | entityid (workScheduleLivestockUnits) | workorders[].relationships.livestockUnits.data[].id       |
| index_ac_wsentities   | entityid (workScheduleFacilities)     | workorders[].relationships.facilities.data[].id           |
| index_ac_activity     | actname                               | workorders[].activities[].activityName                    |
